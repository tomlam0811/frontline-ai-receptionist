import { randomUUID } from 'node:crypto';
import { fromPglite, inOwnerScope } from '../../server/api/post-onboarding/database.js';
import { readDemo, updateDemo } from '../../server/api/post-onboarding/demo-store.js';
import { markShareActive, markShareConsumed } from '../../server/api/post-onboarding/share.js';
import { asOwner } from './fixtures.js';

// What the existing terminal path and the voice worker do to a call. The connection commits wire the real ones
// (PO-C1, PO-C19); until then these stand in for them, on the real database and through the real store functions.

/** The terminal path: settles the paid reservation, ends the demo, and consumes a share link. Safe to repeat. */
export const terminalPath = (pg) => async ({ scopeId, demoId }) => {
  const db = fromPglite(pg);
  const demo = await readDemo(db, scopeId, demoId);
  if (!demo || demo.state === 'ended') return { demoId, state: 'ended' };
  await inOwnerScope(db, scopeId, (tx) => tx.query("SELECT settle_voice_start($1::uuid,'completed')", [demo.reservationId]));
  await updateDemo(db, scopeId, demoId, (current) => ({ state: 'ended', endedAt: current.endedAt ?? new Date().toISOString(), terminalReason: 'caller_ended', voiceCleanupCompleted: true }));
  if (demo.shareGrantId) await markShareConsumed({ db, demo, reason: 'caller_ended' });
  return { demoId, state: 'ended' };
};

/** The worker's readiness call: the demo becomes active with server deadlines (soft close at 270 s, hard end at 300 s). */
export async function workerReady(pg, scopeId, demoId, { startedAgoSeconds = 0 } = {}) {
  const db = fromPglite(pg);
  const startedAt = Date.now() - startedAgoSeconds * 1000;
  const demo = await updateDemo(db, scopeId, demoId, () => ({
    state: 'active', startedAt: new Date(startedAt).toISOString(), softCloseAt: new Date(startedAt + 270_000).toISOString(), hardEndAt: new Date(startedAt + 300_000).toISOString(),
  }));
  if (demo.shareGrantId) await markShareActive({ db, demo });
  return demo;
}

/** The worker persisting one finalized caller turn (all the server keeps of what the caller said). Runs as the app role, like the worker's own writes. */
export async function callerSays(pg, scopeId, demoId, text, sequence = 1) {
  await inOwnerScope(fromPglite(pg), scopeId, async (tx) => {
    const state = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR UPDATE', [scopeId])).rows[0].state;
    ((state.callerTurns ??= {})[demoId] ??= []).push({ callerTurnId: randomUUID(), clientTurnId: randomUUID(), demoId, sequence, text, finalized: true, recordedAt: new Date().toISOString(), workflowRevision: 1 });
    await tx.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1 WHERE owner_scope_id = $1::uuid', [scopeId, JSON.stringify(state)]);
  });
}

/** Every demo id in a scope, oldest first. */
export const demoIds = (pg, scopeId) => asOwner(pg, async () => Object.keys((await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId])).rows[0].state.demos ?? {}));
export const scopeState = (pg, scopeId) => asOwner(pg, async () => (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId])).rows[0].state);

/** A guest browser talking to the real handler: no CSRF pair, the fl_guest cookie, the custom header a cross-site form cannot send. */
/** @param {any} app @returns {(path: string, options?: {method?: string, cookie?: string, body?: unknown, headers?: Record<string, string>}) => Promise<Response>} */
export const guestFetch = (app) => (path, { method = 'POST', cookie, body, headers = {} } = {}) => app.fetch(`${app.baseUrl}${path}`, {
  method, headers: { origin: app.baseUrl, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : { 'x-frontline-guest': '1' }), ...headers }, body: body ? JSON.stringify(body) : undefined,
});
export const tokenOf = (url) => new URL(url).hash.replace('#t=', '');
export const hashOf = (url) => new URL(url).hash;
