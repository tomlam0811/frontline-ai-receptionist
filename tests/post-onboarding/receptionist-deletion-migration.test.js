import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withoutOuterTransaction } from '../../scripts/lib/migration-runner.mjs';
import { createMigratedDatabase } from './database.js';
import { asOwner, hash, seedClaimedOwner } from './fixtures.js';

// Migration 018 (MR-D6, MR-B5): applies on the real chain, its rollback removes the two functions it added while keeping
// feedback, share links and owner scope content, and delete_receptionist_records refuses what it must refuse.
const rollback = () => withoutOuterTransaction(readFileSync(new URL('../../migrations/rollback/018_receptionist_deletion.down.sql', import.meta.url), 'utf8'));
const NAMES = ['delete_receptionist_records', 'list_scopes_with_pending_receptionist_deletions'];
const routines = async (pg) => (await pg.query('SELECT proname FROM pg_proc WHERE proname = ANY($1) ORDER BY proname', [NAMES])).rows.map((row) => row.proname);
const insertLink = (pg, owner, status) => asOwner(pg, () => pg.query(
  `INSERT INTO frontline_share_grants(owner_scope_id, stable_agent_id, agent_version_id, token_hash, status, created_by_ref, expires_at, idempotency_key, payload_digest)
   VALUES ($1,$2,$2,$3,$4,$5,now() + interval '1 day',$6,$5)`, [owner.scopeId, owner.agentId, hash(randomUUID()), status, hash('ref'), randomUUID()]));
const setLineage = (pg, owner, lineage) => asOwner(pg, () => pg.query("UPDATE scoped_workspace_states SET state = jsonb_set(state, '{agentLineages}', $2::jsonb) WHERE owner_scope_id = $1", [owner.scopeId, JSON.stringify(lineage)]));
const asScope = async (pg, scopeId, fn) => {
  await pg.exec('SET ROLE frontline_app');
  try { return await pg.transaction(async (tx) => { await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [scopeId]); return fn(tx); }); } finally { await pg.exec('RESET ROLE'); }
};

describe('migration 018 and its rollback', () => {
  it('adds the two functions, and the rollback removes them without touching feedback, links or owner content', async () => {
    const pg = await createMigratedDatabase();
    expect(await routines(pg)).toEqual(NAMES);
    const owner = await seedClaimedOwner(pg, { researched: true });
    await insertLink(pg, owner, 'revoked');
    await asOwner(pg, async () => {
      const stateBefore = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
      await pg.exec('RESET ROLE');
      await pg.exec(rollback());
      expect(await routines(pg)).toEqual([]);
      expect((await pg.query('SELECT count(*)::int AS n FROM frontline_share_grants')).rows[0].n).toBe(1);
      expect((await pg.query('SELECT count(*)::int AS n FROM frontline_claimed_targets')).rows[0].n).toBe(1);
      expect((await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state).toEqual(stateBefore);
      await pg.exec(rollback());
      expect(await routines(pg)).toEqual([]);
    });
  });

  it('gives the runtime role both functions and the cleanup role neither', async () => {
    const pg = await createMigratedDatabase();
    const can = async (role) => (await pg.query("SELECT p.proname FROM pg_proc p WHERE has_function_privilege($1, p.oid, 'EXECUTE') AND p.proname = ANY($2) ORDER BY p.proname", [role, NAMES])).rows.map((row) => row.proname);
    expect(await can('frontline_app')).toEqual(NAMES);
    expect(await can('frontline_cleanup')).toEqual([]);
  });
});

describe('delete_receptionist_records', () => {
  const call = (owner, agentId = owner.agentId, scopeId = owner.scopeId) => (tx) => tx.query('SELECT delete_receptionist_records($1::uuid,$2::uuid) AS removed', [scopeId, agentId]);

  it('refuses another scope', async () => {
    const pg = await createMigratedDatabase();
    const mine = await seedClaimedOwner(pg);
    const other = await seedClaimedOwner(pg);
    await expect(asScope(pg, other.scopeId, call(mine))).rejects.toThrow('owner scope mismatch');
    expect((await pg.query('SELECT count(*)::int AS n FROM frontline_claimed_targets')).rows[0].n).toBe(2);
  });

  it('refuses while the receptionist still exists without the deleting status', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg);
    await setLineage(pg, owner, { [owner.agentId]: { stableAgentId: owner.agentId, status: 'active' } });
    await expect(asScope(pg, owner.scopeId, call(owner))).rejects.toThrow('receptionist_not_deleting');
    expect((await pg.query('SELECT count(*)::int AS n FROM frontline_claimed_targets')).rows[0].n).toBe(1);
  });

  it('refuses while a link is reserved or active, so a live conversation is never cut off', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg);
    await setLineage(pg, owner, { [owner.agentId]: { stableAgentId: owner.agentId, status: 'deleting' } });
    await insertLink(pg, owner, 'active');
    await expect(asScope(pg, owner.scopeId, call(owner))).rejects.toThrow('links_still_live');
    expect((await pg.query('SELECT count(*)::int AS n FROM frontline_share_grants')).rows[0].n).toBe(1);
  });

  it('removes the receptionist links and claimed target, and only those', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg);
    const other = await seedClaimedOwner(pg);
    await setLineage(pg, owner, { [owner.agentId]: { stableAgentId: owner.agentId, status: 'deleting' } });
    await insertLink(pg, owner, 'revoked');
    await insertLink(pg, owner, 'unused');
    await insertLink(pg, other, 'unused');
    await asOwner(pg, () => pg.query("INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at) VALUES ('owner','text','quality','kept',$1,$2,$2,'owner',$3,$4,$3,now() + interval '30 days')", [owner.scopeId, owner.agentId, hash('ref'), randomUUID()]));
    expect((await asScope(pg, owner.scopeId, call(owner))).rows[0].removed).toBe(2);
    await asOwner(pg, async () => {
      expect((await pg.query('SELECT target_id FROM frontline_claimed_targets')).rows).toEqual([{ target_id: other.agentId }]);
      expect((await pg.query('SELECT stable_agent_id FROM frontline_share_grants')).rows).toEqual([{ stable_agent_id: other.agentId }]);
      expect((await pg.query('SELECT submitted_text FROM frontline_feedback')).rows).toEqual([{ submitted_text: 'kept' }]);
    });
    // A repeat finds nothing to do.
    expect((await asScope(pg, owner.scopeId, call(owner))).rows[0].removed).toBe(0);
  });

  it('runs once the receptionist is already gone from the scope JSON', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg);
    await setLineage(pg, owner, {});
    expect((await asScope(pg, owner.scopeId, call(owner))).rows[0].removed).toBe(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM frontline_claimed_targets')).rows[0].n).toBe(0);
  });
});

describe('list_scopes_with_pending_receptionist_deletions', () => {
  it('names only scopes with a pending, or failed and under three attempts, delete job', async () => {
    const pg = await createMigratedDatabase();
    const jobs = { pending: { status: 'pending', attempts: 0 }, retry: { status: 'failed', attempts: 2 }, spent: { status: 'failed', attempts: 3 }, done: { status: 'completed', attempts: 0 } };
    const owners = {};
    for (const [name, job] of Object.entries(jobs)) {
      owners[name] = await seedClaimedOwner(pg);
      await asOwner(pg, () => pg.query("UPDATE scoped_workspace_states SET state = jsonb_set(state, '{receptionistDeletions}', $2::jsonb) WHERE owner_scope_id = $1", [owners[name].scopeId, JSON.stringify({ [randomUUID()]: job })]));
    }
    await seedClaimedOwner(pg);
    await pg.exec('SET ROLE frontline_app');
    const listed = (await pg.query('SELECT list_scopes_with_pending_receptionist_deletions(50) AS scope_id')).rows.map((row) => row.scope_id).sort();
    await pg.exec('RESET ROLE');
    expect(listed).toEqual([owners.pending.scopeId, owners.retry.scopeId].sort());
  });
});
