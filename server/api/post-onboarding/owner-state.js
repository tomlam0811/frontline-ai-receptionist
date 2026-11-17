import { inOwnerScope } from './database.js';
import { problem } from './errors.js';

/**
 * Runs fn(state) under the owner scope row lock. fn returns { result, state?, thenThrow? }.
 * - `state` is written back (version + 1) only when present, so pure reads never write.
 * - `thenThrow` is thrown after the write commits. It is how a request records something durable (an update
 *   marked `conflict`) and still answers with an error, which a plain throw would roll back.
 * This is the same row and the same locking as the existing store transaction (connection PO-C2 replaces it).
 * @template T
 * @param {any} db @param {string} scopeId @param {(state: any) => Promise<{result?: T, state?: any, thenThrow?: Error}> | {result?: T, state?: any, thenThrow?: Error}} fn
 * @returns {Promise<T>}
 */
export async function withOwnerState(db, scopeId, fn) {
  let thenThrow;
  const result = await inOwnerScope(db, scopeId, async (tx) => {
    const { rows } = await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR UPDATE', [scopeId]);
    const state = rows[0]?.state;
    if (!state) throw problem(404, 'not_found', 'Not found.');
    const out = await fn(state);
    if (out.state) await tx.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1::uuid', [scopeId, JSON.stringify(out.state)]);
    thenThrow = out.thenThrow;
    return out.result;
  });
  if (thenThrow) throw thenThrow;
  return result;
}
