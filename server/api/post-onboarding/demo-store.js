import { inOwnerScope } from './database.js';
import { problem } from './errors.js';

// Writes and reads demo records inside the owner scope JSONB, the same document the
// existing store keeps them in, and mirrors PostgresStore.indexDemos so the worker routes
// and the hard-end watchdog can find the demo. At connection (PO-C1) these calls are
// replaced by store.transaction(...), which does the same indexing itself.

/** Inserts a demo record and indexes it. Call inside inOwnerScope. */
export async function insertDemo(tx, scopeId, demo) {
  const result = await tx.query(
    `UPDATE scoped_workspace_states SET state = jsonb_set(state, '{demos}', COALESCE(state->'demos', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)),
       version = version + 1, updated_at = now() WHERE owner_scope_id = $1::uuid`, [scopeId, demo.id, JSON.stringify(demo)]);
  if ((result.rowCount ?? result.affectedRows) !== 1) throw problem(404, 'not_found', 'Not found.');
  await indexDemo(tx, scopeId, demo);
}

async function indexDemo(tx, scopeId, demo) {
  await tx.query('SELECT index_internal_demo_scope($1::uuid,$2::uuid)', [demo.id, scopeId]);
  const deadline = demo.hardEndAt ?? demo.setupDeadlineAt;
  if (deadline && demo.reservationId) {
    if (['ended', 'failed'].includes(demo.state) && demo.voiceCleanupCompleted !== true) return;
    await tx.query('SELECT upsert_demo_deadline($1::uuid,$2::uuid,$3::text,$4::uuid,$5::timestamptz,$6::text,$7::text)',
      [demo.id, scopeId, demo.roomName, demo.reservationId, deadline, demo.hardEndAt ? 'active' : 'setup', demo.voiceCleanupCompleted === true ? 'ended' : 'active']);
  }
}

/** Reads one demo (a copy) and applies fn(demo) -> patch, under the scope row lock. */
export async function updateDemo(db, scopeId, demoId, fn) {
  return inOwnerScope(db, scopeId, async (tx) => {
    const { rows } = await tx.query("SELECT state->'demos'->$2::text AS demo FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR UPDATE", [scopeId, demoId]);
    const current = rows[0]?.demo;
    if (!current) throw problem(404, 'not_found', 'Not found.');
    const next = { ...current, ...(await fn(structuredClone(current))) };
    await tx.query('UPDATE scoped_workspace_states SET state = jsonb_set(state, $2::text[], $3::jsonb), version = version + 1, updated_at = now() WHERE owner_scope_id = $1::uuid', [scopeId, ['demos', demoId], JSON.stringify(next)]);
    await indexDemo(tx, scopeId, next);
    return next;
  });
}

export async function readDemo(db, scopeId, demoId) {
  return inOwnerScope(db, scopeId, async (tx) => {
    const { rows } = await tx.query("SELECT state->'demos'->$2::text AS demo FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid", [scopeId, demoId]);
    return rows[0]?.demo ?? null;
  });
}
