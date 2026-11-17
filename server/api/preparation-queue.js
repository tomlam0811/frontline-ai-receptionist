import { createHash, randomUUID } from 'node:crypto';
import { compileBusinessKnowledge } from './knowledge.js';
import { PostgresStore, serializePostgresState } from './postgres-store.js';

const LEASE_SECONDS = 150;
const EMPTY_PROFILE = { businessName: null, location: null, services: [], hours: null, sources: [] };
const clientHash = (key) => createHash('sha256').update(String(key || 'unknown')).digest('hex');
const safeLogValue = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'unknown';

function logPreparationFailure(stage, error, jobId) {
  // Never log the URL, provider response, extracted text, SQL parameters or
  // exception message. Railway attaches the timestamp to this structured line.
  console.error(JSON.stringify({
    event: 'preparation_failure',
    stage,
    jobId: jobId ?? null,
    errorName: safeLogValue(error?.name),
    errorCode: safeLogValue(error?.code),
  }));
}

/** True when a research provider refused the account (no credit, bad key), anywhere in the error's cause chain. */
function accountUnavailable(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (current.accountUnavailable === true || ['exa_account_unavailable', 'exa_not_configured'].includes(current.code)) return true;
  }
  return false;
}

function applyPreparation(state, id, prepared, error) {
  const record = state.preparations[id];
  if (!record || record.state !== 'researching' || Date.parse(record.expiresAt) <= Date.now()) return;
  if (error) {
    record.state = 'failed_retryable';
    record.error = accountUnavailable(error)
      ? { code: 'research_unavailable', message: "Website reading isn't available right now. Please contact the Frontline team." }
      : { code: 'inspection_failed', message: 'The website could not be prepared.' };
    return;
  }
  const compiled = compileBusinessKnowledge(prepared);
  record.state = compiled ? prepared?.readiness : 'insufficient_context';
  record.profile = prepared?.profile ?? EMPTY_PROFILE;
  record.gaps = prepared?.gaps ?? ['business_context_unavailable'];
  record.businessFit = prepared?.businessFit ?? null;
  record.capabilityManifest = compiled?.manifest ?? null;
  if (record.state === 'ready' || record.state === 'limited_ready') {
    record.knowledgeRevisionId = compiled.groupedProfile?.knowledgeRevisionId ?? randomUUID();
    record.profileRevisionId = compiled.groupedProfile?.profileRevisionId ?? null;
    record.groupedProfile = compiled.groupedProfile;
    record.groupedFacts = compiled.groupedFacts;
    record.agentVersionId = randomUUID();
    state.knowledge[record.knowledgeRevisionId] = { id: record.knowledgeRevisionId, workspaceId: record.workspaceId, facts: compiled.facts, groupedFacts: compiled.groupedFacts, groupedProfile: compiled.groupedProfile, classifiedPassages: compiled.classifiedPassages, sources: record.profile.sources, expiresAt: record.expiresAt };
    state.agents[record.agentVersionId] = { id: record.agentVersionId, workspaceId: record.workspaceId, knowledgeRevisionId: record.knowledgeRevisionId, profileRevisionId: record.profileRevisionId, capabilityManifest: record.capabilityManifest, expiresAt: record.expiresAt };
  }
}

export function createPreparationQueue({ store, prepare, paidResearch = null }) {
  if (store instanceof PostgresStore) return createPostgresQueue(store, prepare, paidResearch);
  return createDevelopmentQueue(store, prepare, paidResearch);
}

function createDevelopmentQueue(store, prepare, paidResearch) {
  const clients = new Map();
  const scopes = new Map();
  const activeClients = new Set();
  const scopeHistory = new Map();
  const globalHistory = [];
  const dailyPaidHistory = [];
  let active = 0;
  return {
    async enqueue({ id, workspaceId, clientKey, url }) {
      const now = Date.now();
      const key = clientHash(clientKey);
      for (const [hash, entries] of clients) {
        const recent = entries.filter((time) => now - time < 60_000);
        if (recent.length) clients.set(hash, recent); else clients.delete(hash);
      }
      for (const [scope, entries] of scopeHistory) {
        const recentEntries = entries.filter((time) => now - time < 86_400_000);
        if (recentEntries.length) scopeHistory.set(scope, recentEntries); else scopeHistory.delete(scope);
      }
      const recent = clients.get(key) ?? [];
      const scopeRecent = (scopeHistory.get(workspaceId) ?? []).filter((time) => now - time < 86_400_000);
      while (globalHistory.length && now - globalHistory[0] >= 60_000) globalHistory.shift();
      while (dailyPaidHistory.length && now - dailyPaidHistory[0] >= 86_400_000) dailyPaidHistory.shift();
      if (active >= 2 || activeClients.has(key) || scopes.get(workspaceId)) return 'inspection_busy';
      if (paidResearch && (!Number.isSafeInteger(paidResearch.dailyLimit) || paidResearch.dailyLimit < 1 || dailyPaidHistory.length >= paidResearch.dailyLimit)) return 'rate_limited';
      if (recent.length >= 6 || scopeRecent.length >= 12 || globalHistory.length >= 60 || clients.size >= 10_000 || scopeHistory.size >= 10_000) return 'rate_limited';
      clients.set(key, [...recent, now]);
      scopeHistory.set(workspaceId, [...scopeRecent, now]);
      globalHistory.push(now);
      if (paidResearch) dailyPaidHistory.push(now);
      scopes.set(workspaceId, true);
      activeClients.add(key);
      active += 1;
      setImmediate(async () => {
        try {
          let prepared;
          let error;
          try { prepared = await prepare(url); } catch (cause) { error = cause; }
          await store.transaction((state) => applyPreparation(state, id, prepared, error));
        } catch (error) {
          console.error('Development preparation failed to persist.');
          try { await store.transaction((state) => applyPreparation(state, id, null, error)); }
          catch { /* The development store may be unavailable. */ }
        } finally {
          scopes.delete(workspaceId);
          activeClients.delete(key);
          active -= 1;
        }
      });
      return 'admitted';
    },
    start() {},
    stop() {},
    healthy() { return true; },
  };
}

function createPostgresQueue(store, prepare, paidResearch) {
  let timer;
  let running = false;
  let stopped = true;
  let healthy = false;

  async function mutateScoped(job, operation) {
    const client = await store.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [job.ownerScopeId]);
      const { rows } = await client.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1 FOR UPDATE', [job.ownerScopeId]);
      if (!rows.length) { await client.query('ROLLBACK'); return; }
      const state = rows[0].state;
      const changed = await operation(client, state);
      if (changed) await client.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1', [job.ownerScopeId, serializePostgresState(state)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function finish(job, prepared, error) {
    await mutateScoped(job, async (client, state) => {
      const valid = await client.query('SELECT renew_preparation_lease($1::uuid,$2::uuid,$3::integer) AS valid', [job.id, job.leaseToken, LEASE_SECONDS]);
      if (!valid.rows[0]?.valid) return false;
      const outcome = await client.query('SELECT settle_preparation_job($1::uuid,$2::uuid,$3::boolean) AS state', [job.id, job.leaseToken, !error]);
      const settled = outcome.rows[0]?.state;
      if (settled === 'complete') applyPreparation(state, job.id, prepared, null);
      if (settled === 'failed') applyPreparation(state, job.id, null, error);
      return settled === 'complete' || settled === 'failed';
    });
  }

  async function processJob(job) {
    const scoped = await store.pool.connect();
    let url;
    try {
      await scoped.query('BEGIN');
      await scoped.query("SELECT set_config('app.owner_scope_id', $1, true)", [job.ownerScopeId]);
      const { rows } = await scoped.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [job.ownerScopeId]);
      url = rows[0]?.state?.preparations?.[job.id]?.url;
      await scoped.query('COMMIT');
    } catch (error) {
      await scoped.query('ROLLBACK');
      throw error;
    } finally { scoped.release(); }
    if (!url) { await finish(job, null, new Error('Preparation unavailable.')); return; }
    let leaseAlive = true;
    const heartbeat = setInterval(async () => {
      try {
        const result = await store.pool.query('SELECT renew_preparation_lease($1::uuid,$2::uuid,$3::integer) AS valid', [job.id, job.leaseToken, LEASE_SECONDS]);
        leaseAlive = Boolean(result.rows[0]?.valid);
      } catch { leaseAlive = false; }
    }, 30_000);
    heartbeat.unref?.();
    try {
      let prepared;
      let error;
      try { prepared = await prepare(url); } catch (cause) { error = cause; logPreparationFailure('research', cause, job.id); }
      if (leaseAlive) {
        try { await finish(job, prepared, error); }
        catch (cause) { logPreparationFailure('persist', cause, job.id); throw cause; }
      } else {
        logPreparationFailure('lease', new Error('lease_lost'), job.id);
      }
    } finally { clearInterval(heartbeat); }
  }

  async function reconcileTerminal() {
    const { rows } = await store.pool.query('SELECT * FROM list_terminal_preparation_jobs()');
    for (const row of rows) {
      const job = { id: row.job_id, ownerScopeId: row.owner_scope_id };
      await mutateScoped(job, async (_client, state) => {
        const record = state.preparations[job.id];
        if (!record || record.state !== 'researching') return false;
        applyPreparation(state, job.id, null, new Error('Preparation attempts exhausted.'));
        return true;
      });
      await store.pool.query('SELECT acknowledge_terminal_preparation_job($1::uuid)', [job.id]);
    }
  }

  async function sweep() {
    if (running || stopped) return;
    running = true;
    try {
      await reconcileTerminal();
      const { rows } = await store.pool.query('SELECT * FROM lease_preparation_job($1::integer)', [LEASE_SECONDS]);
      healthy = true;
      if (rows.length) await processJob({ id: rows[0].job_id, ownerScopeId: rows[0].owner_scope_id, leaseToken: rows[0].lease_token });
    } catch (error) {
      // The queue remains closed to new admissions when its database functions
      // are unavailable. Polling resumes so a repaired migration can recover.
      healthy = false;
      logPreparationFailure('sweep', error, null);
    } finally { running = false; }
  }

  return {
    async enqueueInTransaction(client, { id, workspaceId, clientKey }) {
      if (stopped || !healthy) return 'inspection_unavailable';
      const { rows } = paidResearch
        ? await client.query('SELECT admit_bounded_preparation_job($1::uuid,$2::uuid,$3::text,$4::integer) AS result', [id, workspaceId, clientHash(clientKey), paidResearch.dailyLimit])
        : await client.query('SELECT admit_preparation_job($1::uuid,$2::uuid,$3::text) AS result', [id, workspaceId, clientHash(clientKey)]);
      return rows[0]?.result ?? 'inspection_unavailable';
    },
    async start() {
      if (!stopped) return;
      await store.ensureReady();
      // Startup fails closed if the migration is absent or runtime grants are wrong.
      await store.pool.query('SELECT * FROM list_terminal_preparation_jobs()');
      const admissionSignature = paidResearch ? 'admit_bounded_preparation_job(uuid,uuid,text,integer)' : 'admit_preparation_job(uuid,uuid,text)';
      const grants = await store.pool.query("SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS admission, has_function_privilege(current_user, 'lease_preparation_job(integer)', 'EXECUTE') AS lease, has_function_privilege(current_user, 'renew_preparation_lease(uuid,uuid,integer)', 'EXECUTE') AS renew, has_function_privilege(current_user, 'settle_preparation_job(uuid,uuid,boolean)', 'EXECUTE') AS settle", [admissionSignature]);
      if (Object.values(grants.rows[0] ?? {}).some((allowed) => !allowed)) throw new Error('Preparation queue functions are unavailable.');
      healthy = true;
      stopped = false;
      timer = setInterval(() => { void sweep(); }, 2_000);
      timer.unref?.();
      void sweep();
    },
    stop() { stopped = true; healthy = false; clearInterval(timer); },
    healthy() { return !stopped && healthy; },
  };
}
