import pg from 'pg';
import { fromPool } from './post-onboarding/database.js';
import { sweepExpiredConversations } from './post-onboarding/retention.js';
import { sweepReceptionistDeletions } from './post-onboarding/receptionist-deletion.js';
import { sweepAccountDeletions } from './post-onboarding/account-deletion.js';
import { sweepSourceErasures } from './post-onboarding/source-erasure.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const BATCH_LIMIT = 50;
const MAX_BATCHES_PER_SWEEP = 20;
const POST_ONBOARDING_BATCH_LIMIT = 100;
const POST_ONBOARDING_SCOPE_BATCH_LIMIT = 50;
// The post-onboarding sweeps run only when the feature is on, so a deployment that has not applied migration 014 is unaffected.
const postOnboardingOn = () => ['1', 'on', 'true'].includes(String(process.env.FRONTLINE_POST_ONBOARDING ?? '').trim().toLowerCase());

/** Runs physical anonymous-scope deletion with a separate, cleanup-only DB role. */
export function createAnonymousRetention(options = {}) {
  const connectionString = options.connectionString ?? process.env.FRONTLINE_CLEANUP_DATABASE_URL;
  if (!connectionString && !options.pool) throw new Error('FRONTLINE_CLEANUP_DATABASE_URL is required for anonymous retention.');
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 1 });
  // Conversations live inside each owner's scope record. Only the runtime role may read one, under that owner's
  // row level security, so this sweep uses its own connection and never the cleanup role.
  const postOnboarding = options.postOnboarding ?? postOnboardingOn();
  const runtimeConnectionString = options.runtimeConnectionString ?? process.env.DATABASE_URL;
  if (postOnboarding && !runtimeConnectionString && !options.runtimePool) throw new Error('DATABASE_URL is required for post-onboarding retention.');
  const runtimePool = postOnboarding ? options.runtimePool ?? new pg.Pool({ connectionString: runtimeConnectionString, max: 1 }) : null;
  // A dropped idle connection fires 'error' on the pool outside any query; unhandled, that is a
  // fatal, process-crashing event in Node, not just a failed sweep. Only attach to a pool we made
  // ourselves, so a shared pool injected by a test does not pick up a second listener.
  const onPoolError = (label) => (error) => console.error(JSON.stringify({ event: 'postgres_pool_error',
    pool: label, errorName: error?.name ?? 'Error', errorCode: typeof error?.code === 'string' ? error.code : null }));
  if (!options.pool) pool.on('error', onPoolError('retention_cleanup'));
  if (postOnboarding && !options.runtimePool) runtimePool.on('error', onPoolError('retention_runtime'));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 15 * 60_000) {
    throw new Error('Invalid anonymous retention interval.');
  }
  let timer;
  let lastSucceededAt = 0;
  let running;
  let closed = false;
  let closePromise;

  // Returns counts only. Expired feedback, guest capabilities and share grants go by SQL as the cleanup role;
  // finished conversations past retention are pruned by the runtime role, scope by scope.
  async function sweepPostOnboarding() {
    const counts = { feedback: 0, guestCapabilities: 0, shareGrants: 0, scopes: 0, conversations: 0, erasureJobs: 0, erasuresCompleted: 0, deletionJobs: 0, deletionsCompleted: 0, accountDeletionJobs: 0, accountDeletionsCompleted: 0, accountDeletionsStuck: 0 };
    for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
      const { rows } = await pool.query('SELECT * FROM cleanup_expired_post_onboarding($1::integer)', [POST_ONBOARDING_BATCH_LIMIT]);
      const deleted = [rows[0]?.feedback, rows[0]?.guest_capabilities, rows[0]?.share_grants].map(Number);
      if (deleted.some((count) => !Number.isSafeInteger(count) || count < 0 || count > POST_ONBOARDING_BATCH_LIMIT)) throw new Error('Invalid retention cleanup result.');
      counts.feedback += deleted[0]; counts.guestCapabilities += deleted[1]; counts.shareGrants += deleted[2];
      if (Math.max(...deleted) < POST_ONBOARDING_BATCH_LIMIT) break;
    }
    // Unfinished source removals resume as the runtime role, scope by scope. It has no live-call terminal path,
    // so a job with a live call waits for that call's own deadline.
    const db = fromPool(runtimePool);
    const erasures = await sweepSourceErasures({ db, limit: POST_ONBOARDING_SCOPE_BATCH_LIMIT });
    counts.erasureJobs += erasures.jobs; counts.erasuresCompleted += erasures.completed;
    // Same for receptionist deletes. A delete whose call is still live waits for the call's own deadline.
    const deletions = await sweepReceptionistDeletions({ db, limit: POST_ONBOARDING_SCOPE_BATCH_LIMIT });
    counts.deletionJobs += deletions.jobs; counts.deletionsCompleted += deletions.completed;
    // Same for account deletes (migration 019). A business with a live call waits for the call's own deadline. It then
    // removes what finished deletes no longer need: expired ended sessions, and scope rows whose feedback has expired.
    // A failure is logged and does not stop the conversation sweep below; the next sweep retries.
    try {
      const accounts = await sweepAccountDeletions({ db, limit: POST_ONBOARDING_SCOPE_BATCH_LIMIT });
      counts.accountDeletionJobs += accounts.jobs; counts.accountDeletionsCompleted += accounts.completed; counts.accountDeletionsStuck += accounts.stuckJobs;
      if (accounts.stuckJobs > 0) console.error(JSON.stringify({ event: 'account_deletion_stuck', jobs: accounts.stuckJobs }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'account_deletion_sweep_failed', errorName: error?.name ?? 'Error', errorCode: typeof error?.code === 'string' ? error.code : null }));
    }
    for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
      const swept = await sweepExpiredConversations({ db, limit: POST_ONBOARDING_SCOPE_BATCH_LIMIT });
      counts.scopes += swept.scopes; counts.conversations += swept.conversations;
      if (swept.scopes < POST_ONBOARDING_SCOPE_BATCH_LIMIT) break;
    }
    return counts;
  }

  async function sweep() {
    if (closed) throw new Error('Anonymous retention is closed.');
    if (running) return running;
    running = (async () => {
      // The function returns only a count; no prospect data enters this process.
      let deleted = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
        const { rows } = await pool.query('SELECT cleanup_expired_anonymous_scopes($1::integer) AS deleted', [BATCH_LIMIT]);
        const count = Number(rows[0]?.deleted);
        if (!Number.isSafeInteger(count) || count < 0 || count > BATCH_LIMIT) throw new Error('Invalid retention cleanup result.');
        deleted += count;
        if (count < BATCH_LIMIT) break;
      }
      if (postOnboarding) await sweepPostOnboarding();
      lastSucceededAt = Date.now();
      return deleted;
    })();
    try { return await running; }
    catch (error) { lastSucceededAt = 0; throw error; }
    finally { running = undefined; }
  }

  async function start({ keepAlive = false } = {}) {
    if (closed) throw new Error('Anonymous retention is closed.');
    if (timer) return;
    const { rows } = await pool.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    if (rows[0]?.role !== 'frontline_cleanup' || rows[0].rolsuper || rows[0].rolbypassrls) {
      throw new Error('Anonymous retention requires the dedicated, unprivileged frontline_cleanup database role.');
    }
    if (runtimePool) {
      const runtime = (await runtimePool.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
      if (!runtime || runtime.role === 'frontline_cleanup' || runtime.rolsuper || runtime.rolbypassrls) {
        throw new Error('Post-onboarding retention requires the unprivileged runtime database role for conversations.');
      }
    }
    await sweep();
    timer = setInterval(() => { void sweep().catch((error) => options.onSweepError?.(error)); }, intervalMs);
    if (!keepAlive) timer.unref?.();
  }

  function healthy() {
    return Boolean(timer && lastSucceededAt && Date.now() - lastSucceededAt < intervalMs * 2);
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    closePromise = (async () => {
      if (running) { try { await running; } catch { /* Closing after failure. */ } }
      await pool.end();
      await runtimePool?.end();
    })();
    return closePromise;
  }

  return { start, sweep, sweepPostOnboarding, healthy, close };
}
