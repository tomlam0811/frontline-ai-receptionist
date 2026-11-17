import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withoutOuterTransaction } from '../../scripts/lib/migration-runner.mjs';
import { createMigratedDatabase } from './database.js';
import { asOwner, hash, seedClaimedOwner } from './fixtures.js';

// Migration 019 (PO-D12, PO-TD16): applies on the real chain, its rollback removes what it added while keeping owner
// content, and the scope step refuses what it must refuse.
const rollback = () => withoutOuterTransaction(readFileSync(new URL('../../migrations/rollback/019_account_deletion.down.sql', import.meta.url), 'utf8'));
const NAMES = ['complete_frontline_account_deletion', 'delete_frontline_account_scope', 'fail_frontline_account_deletion', 'list_pending_frontline_account_deletions', 'purge_frontline_account_leftovers', 'read_frontline_account_deletion', 'start_frontline_account_deletion'];
const routines = async (pg) => (await pg.query('SELECT proname FROM pg_proc WHERE proname = ANY($1) ORDER BY proname', [NAMES])).rows.map((row) => row.proname);
const hasJobTable = async (pg) => (await pg.query("SELECT to_regclass('frontline_account_deletions') IS NOT NULL AS present")).rows[0].present;
const asApp = async (pg, fn) => { await pg.exec('SET ROLE frontline_app'); try { return await fn(); } finally { await pg.exec('RESET ROLE'); } };
const asScope = (pg, scopeId, fn) => asApp(pg, () => pg.transaction(async (tx) => { await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [scopeId]); return fn(tx); }));
const startFor = (pg, owner) => asApp(pg, async () => (await pg.query('SELECT * FROM start_frontline_account_deletion($1,$2::uuid)', [hash(owner.authToken), randomUUID()])).rows[0]);
const deleteScope = (jobId, scopeId) => (tx) => tx.query('SELECT delete_frontline_account_scope($1::uuid,$2::uuid) AS outcome', [jobId, scopeId]);

describe('migration 019 and its rollback', () => {
  it('adds the job table and seven functions, and the rollback removes them without touching owner content', async () => {
    const pg = await createMigratedDatabase();
    expect(await routines(pg)).toEqual(NAMES);
    expect(await hasJobTable(pg)).toBe(true);
    const owner = await seedClaimedOwner(pg, { researched: true });
    await asOwner(pg, async () => {
      const stateBefore = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
      await pg.exec('RESET ROLE');
      await pg.exec(rollback());
      expect(await routines(pg)).toEqual([]);
      expect(await hasJobTable(pg)).toBe(false);
      expect((await pg.query('SELECT count(*)::int AS n FROM frontline_claimed_targets')).rows[0].n).toBe(1);
      expect((await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state).toEqual(stateBefore);
      // The restored check refuses the new states for new writes. A repeat of the rollback is harmless.
      await expect(pg.query("UPDATE ownership_scopes SET state = 'deleting' WHERE id = $1", [owner.scopeId])).rejects.toThrow('ownership_scopes_state_check');
      await pg.exec(rollback());
      expect(await routines(pg)).toEqual([]);
    });
  });

  it('refuses while a deletion is unfinished, and keeps a scope kept for feedback once every deletion is done', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg);
    await asOwner(pg, () => pg.query(
      `INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
       VALUES ('owner','text','quality','kept',$1,$2,$2,'owner',$3,'k',$3,now() + interval '30 days')`, [owner.scopeId, owner.agentId, hash(owner.subject)]));
    const job = await startFor(pg, owner);
    await pg.exec('RESET ROLE');
    // Nothing would resume a fenced job without 019, so the rollback refuses and changes nothing.
    await expect(pg.exec(rollback())).rejects.toThrow('account deletions are still running');
    expect(await routines(pg)).toEqual(NAMES);
    expect(await hasJobTable(pg)).toBe(true);
    expect((await asScope(pg, owner.scopeId, deleteScope(job.job_id, owner.scopeId))).rows[0].outcome).toBe('removed');
    await asApp(pg, () => pg.query('SELECT complete_frontline_account_deletion($1::uuid)', [job.job_id]));
    await pg.exec(rollback());
    expect(await hasJobTable(pg)).toBe(false);
    expect((await pg.query('SELECT state FROM ownership_scopes WHERE id = $1', [owner.scopeId])).rows[0].state).toBe('deleted');
  });

  it('gives the runtime role every function and the cleanup role none, and no role the job table', async () => {
    const pg = await createMigratedDatabase();
    const can = async (role) => (await pg.query("SELECT p.proname FROM pg_proc p WHERE has_function_privilege($1, p.oid, 'EXECUTE') AND p.proname = ANY($2) ORDER BY p.proname", [role, NAMES])).rows.map((row) => row.proname);
    expect(await can('frontline_app')).toEqual(NAMES);
    expect(await can('frontline_cleanup')).toEqual([]);
    for (const role of ['frontline_app', 'frontline_cleanup']) {
      expect((await pg.query("SELECT has_table_privilege($1, 'frontline_account_deletions', 'SELECT') AS can", [role])).rows[0].can).toBe(false);
    }
  });
});

describe('delete_frontline_account_scope', () => {
  it('refuses another scope, and a scope that is not part of the job', async () => {
    const pg = await createMigratedDatabase();
    const mine = await seedClaimedOwner(pg);
    const other = await seedClaimedOwner(pg);
    const job = await startFor(pg, mine);
    expect(job.scope_ids).toEqual([mine.scopeId]);
    await expect(asScope(pg, other.scopeId, deleteScope(job.job_id, mine.scopeId))).rejects.toThrow('owner scope mismatch');
    await expect(asScope(pg, other.scopeId, deleteScope(job.job_id, other.scopeId))).rejects.toThrow('not_found');
    expect((await pg.query('SELECT count(*)::int AS n FROM scoped_workspace_states')).rows[0].n).toBe(2);
    expect((await pg.query('SELECT state FROM ownership_scopes WHERE id = $1', [other.scopeId])).rows[0].state).toBe('claimed');
  });

  it('waits while a link is reserved or active, then removes the scope and repeats as done', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg);
    const job = await startFor(pg, owner);
    // A link that went live after the fence (as a worker that raced it would leave it).
    await pg.query(`INSERT INTO frontline_share_grants(owner_scope_id, stable_agent_id, agent_version_id, token_hash, status, created_by_ref, expires_at, idempotency_key, payload_digest)
                    VALUES ($1,$2,$2,$3,'active',$4,now() + interval '1 day',$5,$4)`, [owner.scopeId, owner.agentId, hash(randomUUID()), hash('ref'), randomUUID()]);
    expect((await asScope(pg, owner.scopeId, deleteScope(job.job_id, owner.scopeId))).rows[0].outcome).toBe('waiting');
    await pg.query("UPDATE frontline_share_grants SET status = 'consumed' WHERE owner_scope_id = $1", [owner.scopeId]);
    expect((await asScope(pg, owner.scopeId, deleteScope(job.job_id, owner.scopeId))).rows[0].outcome).toBe('removed');
    expect((await asScope(pg, owner.scopeId, deleteScope(job.job_id, owner.scopeId))).rows[0].outcome).toBe('done');
    expect((await pg.query('SELECT count(*)::int AS n FROM ownership_scopes WHERE id = $1', [owner.scopeId])).rows[0].n).toBe(0);
  });
});

describe('list_pending_frontline_account_deletions', () => {
  it('names pending jobs, and failed jobs once 2^attempts minutes (at most six hours) have passed, however many attempts', async () => {
    const pg = await createMigratedDatabase();
    const ids = { pending: randomUUID(), due: randomUUID(), waiting: randomUUID(), many: randomUUID(), done: randomUUID() };
    await pg.query(`INSERT INTO frontline_account_deletions(id, status, attempts, updated_at) VALUES
      ($1,'pending',0,now()),($2,'failed',2,now() - interval '5 minutes'),($3,'failed',3,now() - interval '5 minutes'),
      ($4,'failed',40,now() - interval '6 hours'),($5,'completed',0,now() - interval '1 day')`, [ids.pending, ids.due, ids.waiting, ids.many, ids.done]);
    const listed = await asApp(pg, async () => (await pg.query('SELECT list_pending_frontline_account_deletions(50) AS job_id')).rows.map((row) => row.job_id).sort());
    expect(listed).toEqual([ids.pending, ids.due, ids.many].sort());
    await expect(asApp(pg, () => pg.query('SELECT list_pending_frontline_account_deletions(0)'))).rejects.toThrow('batch limit');
  });
});
