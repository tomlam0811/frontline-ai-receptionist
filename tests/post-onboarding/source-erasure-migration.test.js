import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withoutOuterTransaction } from '../../scripts/lib/migration-runner.mjs';
import { createMigratedDatabase } from './database.js';
import { hash, seedClaimedOwner } from './fixtures.js';

// Migration 016 (PO-A16, TOM-38 C4): applies on the real chain, and its rollback removes the two functions it added while
// keeping feedback, share links and owner scope content.
const rollback = () => withoutOuterTransaction(readFileSync(new URL('../../migrations/rollback/016_source_erasure.down.sql', import.meta.url), 'utf8'));
const insertFeedback = (pg, owner, label) => pg.query(
  `INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
   VALUES ('owner','text','quality',$1,$2,$3,$3,'owner',$4,$5,$4,now() + interval '30 days')`, [label, owner.scopeId, owner.agentId, hash(label), randomUUID()]);
const routines = async (pg) => (await pg.query("SELECT proname FROM pg_proc WHERE proname IN ('share_fence_versions','list_scopes_with_pending_source_erasures') ORDER BY proname")).rows.map((row) => row.proname);

describe('migration 016 and its rollback', () => {
  it('adds the two functions, and the rollback removes them without touching feedback or owner content', async () => {
    const pg = await createMigratedDatabase();
    expect(await routines(pg)).toHaveLength(2);
    const owner = await seedClaimedOwner(pg, { researched: true });
    await pg.exec('RESET ROLE');
    await insertFeedback(pg, owner, 'feedback-content');
    const stateBefore = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;

    await pg.exec(rollback());
    expect(await routines(pg)).toEqual([]);
    expect((await pg.query('SELECT submitted_text FROM frontline_feedback')).rows).toEqual([{ submitted_text: 'feedback-content' }]);
    expect((await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state).toEqual(stateBefore);
  });

  it('adds no column or grant to the feedback table and no new right for the cleanup role', async () => {
    const pg = await createMigratedDatabase();
    expect((await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'frontline_feedback' AND column_name LIKE 'erasure%'")).rows).toEqual([]);
    const cleanup = (await pg.query("SELECT p.proname FROM pg_proc p WHERE has_function_privilege('frontline_cleanup', p.oid, 'EXECUTE') AND p.proname IN ('share_fence_versions','list_scopes_with_pending_source_erasures')")).rows;
    expect(cleanup).toEqual([]);
  });

  it('runs twice in a row without error, so a repeated rollback is safe', async () => {
    const pg = await createMigratedDatabase();
    await pg.exec(rollback());
    await pg.exec(rollback());
    expect(await routines(pg)).toEqual([]);
  });
});
