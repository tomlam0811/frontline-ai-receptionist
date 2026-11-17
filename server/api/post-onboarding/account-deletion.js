import { randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { problem } from './errors.js';
import { parseCookies, sha256 } from './http.js';
import { isCallLive } from './source-redaction.js';

// Delete the signed-in owner's account for good (PO-D12, PO-R14, PO-A20). A durable job in its own table (migration 019),
// modeled on receptionist-deletion.js.
//
//   1. startAccountDeletion runs start_frontline_account_deletion: in one transaction it revokes every sign-in session of
//      the person, fences every business they own alone (nothing resolves it any more), revokes its share links and
//      removes their memberships. The person comes only from the fl_auth session, never from the request body. It then
//      ends live calls and answers before any cleanup.
//   2. runAccountDeletion removes each fenced business in one transaction (delete_frontline_account_scope), then removes
//      the tenants (complete_frontline_account_deletion). Any step can be repeated. A business with a call that is still
//      live waits for that call to end; the retention worker resumes the job.
//
// Kept: feedback already sent to the Frontline team (it expires on its own 30 day rule, and no longer carries the person's
// reference), and a business that another member also belongs to (only this person's membership goes).

export const ACCOUNT_DELETION_FAILURES = { sessions: 'sessions_not_ended', records: 'record_cleanup_failed', other: 'cleanup_failed' };
const CALL_MODES = new Set(['owner_test', 'shared_guest']);
const AUTH_COOKIE = /^[a-f0-9]{64}$/;

const readJob = async (db, jobId) => {
  const row = (await db.query('SELECT * FROM read_frontline_account_deletion($1::uuid)', [jobId])).rows[0];
  return row ? { jobId: row.job_id, status: row.status, attempts: row.attempts, failureCode: row.failure_code, scopeIds: row.scope_ids ?? [], scopesDone: row.scopes_done ?? [] } : null;
};
const pendingScopes = (job) => job.scopeIds.filter((id) => !job.scopesDone.includes(id));
const readState = (db, scopeId) => inOwnerScope(db, scopeId, async (tx) => (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [scopeId])).rows[0]?.state ?? null);
const stage = (code, cause) => Object.assign(new Error('account deletion stage failed', { cause }), { failureCode: code });

/** Ends the live owner tests and shared calls of one business through the terminal path. Returns the calls still live. */
async function endScopeCalls({ db, scopeId, endLiveCall }) {
  const live = () => readState(db, scopeId).then((state) => Object.values(state?.demos ?? {}).filter(isCallLive));
  const before = await live();
  if (!before.length || typeof endLiveCall !== 'function') return before;
  // No terminal reason names a deletion (docs/post-onboarding-connection.md C1), so the call records the platform-ended one.
  for (const demo of before.filter((item) => CALL_MODES.has(item.mode))) {
    await endLiveCall({ scopeId, demoId: demo.id, sessionId: demo.guestSessionId ?? null, reservationId: demo.reservationId ?? null, terminalReason: 'hard_end_elapsed' });
  }
  return live();
}

/**
 * DELETE /v1/me/account. Fences, ends live calls, and returns before any cleanup. `created` and `resumed` tell the caller
 * whether to start the cleanup. A repeat with the same (now ended) session answers with the same job.
 * @param {{db: any, request: any, endLiveCall?: Function|null, newId?: () => string}} input
 */
export async function startAccountDeletion({ db, request, endLiveCall = null, newId = () => randomUUID() }) {
  const cookie = parseCookies(request).fl_auth;
  if (!cookie || !AUTH_COOKIE.test(cookie)) throw problem(401, 'sign_in_required', 'Sign in again to continue.');
  let row;
  try {
    row = (await db.query('SELECT * FROM start_frontline_account_deletion($1,$2::uuid)', [sha256(cookie), newId()])).rows[0];
  } catch (error) {
    if (error?.code === '28000') throw problem(401, 'sign_in_required', 'Sign in again to continue.');
    throw error;
  }
  if (!row) throw problem(401, 'sign_in_required', 'Sign in again to continue.');
  const job = { jobId: row.job_id, status: row.status, scopeIds: row.scope_ids ?? [], scopesDone: row.scopes_done ?? [] };
  // Live calls end now so nothing keeps talking for a deleted account. A failure here leaves the fence and the job finishes it.
  if (job.status !== 'completed') {
    for (const scopeId of pendingScopes(job)) {
      try { await endScopeCalls({ db, scopeId, endLiveCall }); } catch { /* the job repeats it */ }
    }
  }
  return { jobId: job.jobId, created: row.created === true, resumed: row.created !== true && job.status !== 'completed', response: { status: 'deleted' } };
}

/**
 * Cleanup for one job. Safe to repeat and to run twice at once (each step locks the job row). It never throws for an
 * expected failure: it records `failed` (still fenced) and returns the job. Without `endLiveCall` (the retention worker),
 * a business with a live call waits for the call's own deadline and the job stays `pending`.
 * `stopAfterScopes` stops after that many businesses, so a test can leave the job where a crash would.
 * @param {{db: any, jobId: string, endLiveCall?: Function|null, stopAfterScopes?: number|null}} input
 */
export async function runAccountDeletion({ db, jobId, endLiveCall = null, stopAfterScopes = null }) {
  const start = await readJob(db, jobId);
  if (!start || start.status === 'completed') return start;
  let removed = 0; let waiting = false;
  try {
    for (const scopeId of pendingScopes(start)) {
      let live;
      try { live = await endScopeCalls({ db, scopeId, endLiveCall }); } catch (cause) { throw stage(ACCOUNT_DELETION_FAILURES.sessions, cause); }
      // The terminal path ran and an owner test or shared call is still live: record the failure, the sweep retries.
      // Without a terminal path, or for an older trial call, the scope step below waits for the call's own deadline.
      if (typeof endLiveCall === 'function' && live.some((demo) => CALL_MODES.has(demo.mode))) throw stage(ACCOUNT_DELETION_FAILURES.sessions);
      let outcome;
      try { outcome = (await inOwnerScope(db, scopeId, (tx) => tx.query('SELECT delete_frontline_account_scope($1::uuid,$2::uuid) AS outcome', [jobId, scopeId]))).rows[0]?.outcome; }
      catch (cause) { throw stage(ACCOUNT_DELETION_FAILURES.records, cause); }
      // A room or reservation is still live: that business waits for it, without counting an attempt. The others go on.
      if (outcome === 'waiting') { waiting = true; continue; }
      removed += 1;
      if (stopAfterScopes !== null && removed >= stopAfterScopes) return await readJob(db, jobId);
    }
    if (waiting) return await readJob(db, jobId);
    await db.query('SELECT complete_frontline_account_deletion($1::uuid)', [jobId]);
    return await readJob(db, jobId);
  } catch (error) {
    const code = typeof error?.failureCode === 'string' ? error.failureCode : ACCOUNT_DELETION_FAILURES.other;
    await db.query('SELECT fail_frontline_account_deletion($1::uuid,$2)', [jobId, code]);
    return readJob(db, jobId);
  }
}

/**
 * One sweep for the retention worker (server/api/retention.js). Resumes every job that is pending, or failed and due a
 * retry (a failed job is retried with a growing wait, never dropped), then removes what finished deletions no longer
 * need. Returns counts only. `stuckJobs` counts the jobs this sweep retried that are still failing, for the log.
 */
export async function sweepAccountDeletions({ db, limit = 50, endLiveCall = null }) {
  const { rows } = await db.query('SELECT list_pending_frontline_account_deletions($1::integer) AS job_id', [limit]);
  let completed = 0; let stuckJobs = 0;
  for (const { job_id: jobId } of rows) {
    const job = await runAccountDeletion({ db, jobId, endLiveCall });
    if (job?.status === 'completed') completed += 1;
    if (job?.status === 'failed') stuckJobs += 1;
  }
  const purged = (await db.query('SELECT * FROM purge_frontline_account_leftovers($1::integer)', [Math.min(500, Math.max(1, limit * 10))])).rows[0] ?? {};
  return { jobs: rows.length, completed, stuckJobs, purged: { sessions: Number(purged.sessions ?? 0), scopes: Number(purged.scopes ?? 0), jobs: Number(purged.jobs ?? 0) } };
}
