import { randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { problem } from './errors.js';
import { backfillKnowledgeLibrary, ensureLineage, knownVersionIds, readLineage } from './lineage.js';
import { withOwnerState } from './owner-state.js';
import { endLiveCalls, revokeOpenLinks } from './receptionist-status.js';
import { removeDemoRecords } from './retention.js';
import { isCallLive } from './source-redaction.js';

// Delete one receptionist for good (MR-D6, MR-J5). A durable job in the owner scope JSON, modeled on source-erasure.js.
//
//   1. startReceptionistDeletion fences in one transaction: the lineage status becomes `deleting` and every version is
//      marked unavailable. From then on every owner and guest path treats the receptionist as gone. It then revokes the
//      share links and ends live calls, and answers before any cleanup.
//   2. runReceptionistDeletion removes the rest in resumable steps, each one transaction that also records its phase:
//      links, live calls, conversations, versions and their knowledge snapshots, the lineage, then the rows outside the
//      scope JSON (share link rows and the claimed target). Any step can be repeated. The job is `completed` after the
//      last one, and until then the receptionist stays fenced.
//
// Never touched: the business library (`state.knowledgeLibrary`), other receptionists, preparations, and feedback already
// sent to the Frontline team (it expires on its own 30 day rule).

export const DELETION_FAILURES = { sessions: 'sessions_not_ended', records: 'record_cleanup_failed', other: 'cleanup_failed' };
export const MAX_AUTOMATIC_ATTEMPTS = 3;

/** The phases in the order they run. `fencedAt` is set when the job is created. */
export const DELETION_PHASES = ['linksRevokedAt', 'callsEndedAt', 'conversationsRemovedAt', 'versionsRemovedAt', 'lineageRemovedAt', 'recordsRemovedAt'];

const iso = (now) => now.toISOString();
const isOpen = (job) => job.status !== 'completed';

/** The job as the owner sees it. Ids, timestamps and counts only. */
export function publicDeletionJob(job) {
  return {
    jobId: job.jobId, stableAgentId: job.stableAgentId, status: job.status, requestedAt: job.requestedAt, updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null, failureCode: job.failureCode ?? null, linksRevoked: job.audit.linksRevoked, conversationsRemoved: job.audit.conversations,
  };
}

const openJobFor = (state, stableAgentId) => Object.values(state.receptionistDeletions ?? {}).find((job) => job.stableAgentId === stableAgentId && isOpen(job)) ?? null;
const withJob = (state, job) => ({ ...state, receptionistDeletions: { ...state.receptionistDeletions, [job.jobId]: job } });

/** Every version id the receptionist has, including any published after the job was created. */
const versionIdsOf = (state, job) => [...new Set([...job.versionIds, ...(readLineage(state, job.stableAgentId) ? knownVersionIds(readLineage(state, job.stableAgentId)) : [])])];

/** The receptionist's conversations: every call on one of its versions, whatever its mode. */
const demosOf = (state, job) => {
  const versions = new Set(versionIdsOf(state, job));
  return Object.values(state.demos ?? {}).filter((demo) => demo && (demo.stableAgentId === job.stableAgentId || versions.has(demo.agentVersionId)));
};

/**
 * DELETE /v1/agents/:id. Fences, revokes the links and ends live calls, and returns before any cleanup.
 * `created` and `resumed` tell the caller whether to start the cleanup. A second request while the job is open returns it.
 */
export async function startReceptionistDeletion({ db, actor, endLiveCall = null, now = new Date(), newId = /** @type {() => string} */ (() => randomUUID()) }) {
  const fenced = await withOwnerState(db, actor.scopeId, (raw) => {
    const ensured = ensureLineage(raw, actor.stableAgentId);
    const lineage = ensured && readLineage(ensured, actor.stableAgentId);
    if (!lineage) throw problem(404, 'not_found', 'Not found.');
    const existing = openJobFor(raw, actor.stableAgentId);
    if (existing) {
      if (existing.status !== 'failed') return { result: { job: existing, created: false, resumed: false } };
      const resumed = { ...existing, status: 'pending', updatedAt: iso(now) };
      return { result: { job: resumed, created: false, resumed: true }, state: withJob(raw, resumed) };
    }
    // Knowledge that only lives in this receptionist's own base moves into the business library first, so removing it loses nothing.
    const state = backfillKnowledgeLibrary(ensured, actor.stableAgentId);
    const current = readLineage(state, actor.stableAgentId);
    const job = {
      jobId: newId(), stableAgentId: actor.stableAgentId, status: 'pending', attempts: 0, failureCode: null,
      requestedAt: iso(now), updatedAt: iso(now), completedAt: null, actorRef: actor.creatorRef ?? null, versionIds: knownVersionIds(current),
      phases: { fencedAt: iso(now), ...Object.fromEntries(DELETION_PHASES.map((phase) => [phase, null])) },
      audit: { linksRevoked: 0, conversations: 0 },
    };
    const fencedLineage = {
      ...current, status: 'deleting',
      revisions: current.revisions.map((revision) => (revision.fencedAt ? revision : { ...revision, fencedAt: iso(now), deletionJobId: job.jobId })),
    };
    return { result: { job, created: true, resumed: false }, state: withJob({ ...state, agentLineages: { ...state.agentLineages, [actor.stableAgentId]: fencedLineage } }, job) };
  });

  // Links and live calls are cleared now so the owner sees them gone. A failure here leaves the fence in place and the job finishes it.
  let linksRevoked = 0;
  try {
    linksRevoked = await revokeOpenLinks({ db, actor, endLiveCall });
    await endLiveCalls({ db, actor, endLiveCall, reason: 'agent_deleted' });
  } catch { /* the job repeats both */ }
  return { jobId: fenced.job.jobId, created: fenced.created, resumed: fenced.resumed, response: { stableAgentId: actor.stableAgentId, status: 'deleting', linksRevoked } };
}

const readJob = (db, scopeId, jobId) => withOwnerState(db, scopeId, (state) => ({ result: state.receptionistDeletions?.[jobId] ?? null }));

async function markFailed({ db, scopeId, jobId, code, now }) {
  await withOwnerState(db, scopeId, (state) => {
    const job = state.receptionistDeletions?.[jobId];
    if (!job || job.status === 'completed') return { result: null };
    return { result: null, state: withJob(state, { ...job, status: 'failed', failureCode: code, attempts: job.attempts + 1, updatedAt: iso(now()) }) };
  });
}

const stage = (code, cause) => Object.assign(new Error('deletion stage failed', { cause }), { failureCode: code });

/**
 * One step: in one scope transaction, skips when the phase is already recorded, otherwise applies `change(state, job)`
 * (returning the next state and audit counts) and records the phase with it.
 */
function runPhase({ db, scopeId, jobId, phase, now, change }) {
  return withOwnerState(db, scopeId, (state) => {
    const job = state.receptionistDeletions[jobId];
    if (job.phases[phase]) return { result: false };
    const { state: next = state, audit = {} } = change(state, job);
    const done = { ...job, updatedAt: iso(now()), audit: { ...job.audit, ...audit }, phases: { ...job.phases, [phase]: iso(now()) } };
    return { result: true, state: withJob(next, done) };
  });
}

/** Knowledge records another receptionist, an agent that stays, a preparation or the library's own base still points at. */
function keptKnowledgeIds(state, job, removedVersions) {
  const kept = new Set();
  for (const [id, lineage] of Object.entries(state.agentLineages ?? {})) if (id !== job.stableAgentId) for (const revision of lineage.revisions) kept.add(revision.knowledgeRevisionId);
  for (const [id, agent] of Object.entries(state.agents ?? {})) if (!removedVersions.has(id)) kept.add(agent.knowledgeRevisionId);
  for (const preparation of Object.values(state.preparations ?? {})) kept.add(preparation?.knowledgeRevisionId);
  kept.add(state.knowledgeLibrary?.materializedFromKnowledgeRevisionId);
  return kept;
}

function removeVersions(state, job) {
  const versionIds = new Set(versionIdsOf(state, job));
  const lineage = readLineage(state, job.stableAgentId);
  const snapshotIds = new Set([...(lineage?.revisions ?? []).map((revision) => revision.knowledgeRevisionId), ...[...versionIds].map((id) => state.agents?.[id]?.knowledgeRevisionId)].filter(Boolean));
  const kept = keptKnowledgeIds(state, job, versionIds);
  const agents = Object.fromEntries(Object.entries(state.agents ?? {}).filter(([id]) => !versionIds.has(id)));
  const knowledge = Object.fromEntries(Object.entries(state.knowledge ?? {}).filter(([id]) => !snapshotIds.has(id) || kept.has(id)));
  return { ...state, agents, knowledge };
}

function removeLineage(state, job) {
  const without = (map) => Object.fromEntries(Object.entries(map).filter(([id]) => id !== job.stableAgentId));
  const next = { ...state, agentLineages: without(state.agentLineages ?? {}) };
  if (state.firstVisit) next.firstVisit = without(state.firstVisit);
  if (state.knowledgeBases) next.knowledgeBases = without(state.knowledgeBases);
  return next;
}

/**
 * Cleanup for one job. Safe to repeat and safe to run twice at once. It never throws for an expected failure: it records
 * `failed` (still fenced) and returns the job. `endLiveCall` is the terminal path for a live call; the retention worker has
 * none, so a job that still has a live call waits for the call's own deadline and stays `pending`.
 * `stopAfter` names a phase to stop after, so a test can leave the job where a crash would.
 */
export async function runReceptionistDeletion({ db, scopeId, jobId, endLiveCall = null, now = () => new Date(), stopAfter = null }) {
  const start = await readJob(db, scopeId, jobId);
  if (!start || start.status === 'completed') return start;
  const stopped = (phase) => stopAfter === phase;
  const at = { db, scopeId, jobId, now };
  try {
    // Links: a link created between the fence and now is caught here.
    const actor = { scopeId, stableAgentId: start.stableAgentId, versionNumbers: {} };
    const revoked = await revokeOpenLinks({ db, actor, endLiveCall });
    await runPhase({ ...at, phase: 'linksRevokedAt', change: (state, job) => ({ audit: { linksRevoked: job.audit.linksRevoked + revoked } }) });
    if (stopped('linksRevokedAt')) return await readJob(db, scopeId, jobId);

    const live = () => withOwnerState(db, scopeId, (state) => ({ result: demosOf(state, start).filter(isCallLive) }));
    const liveNow = await live();
    if (liveNow.length) {
      if (!endLiveCall) return await readJob(db, scopeId, jobId);
      for (const demo of liveNow) {
        try { await endLiveCall({ scopeId, demoId: demo.id, sessionId: demo.guestSessionId ?? null, reservationId: demo.reservationId ?? null, reason: 'agent_deleted' }); }
        catch (cause) { throw stage(DELETION_FAILURES.sessions, cause); }
      }
      if ((await live()).length) throw stage(DELETION_FAILURES.sessions);
    }
    await runPhase({ ...at, phase: 'callsEndedAt', change: () => ({}) });
    if (stopped('callsEndedAt')) return await readJob(db, scopeId, jobId);

    await runPhase({
      ...at, phase: 'conversationsRemovedAt',
      change: (state, job) => {
        const demos = demosOf(state, job);
        // A call that started after the check above keeps its record until it ends.
        if (demos.some(isCallLive)) throw stage(DELETION_FAILURES.sessions);
        return { state: removeDemoRecords(state, new Set(demos.map((demo) => demo.id))), audit: { conversations: job.audit.conversations + demos.length } };
      },
    });
    if (stopped('conversationsRemovedAt')) return await readJob(db, scopeId, jobId);

    await runPhase({ ...at, phase: 'versionsRemovedAt', change: (state, job) => ({ state: removeVersions(state, job) }) });
    if (stopped('versionsRemovedAt')) return await readJob(db, scopeId, jobId);

    await runPhase({ ...at, phase: 'lineageRemovedAt', change: (state, job) => ({ state: removeLineage(backfillKnowledgeLibrary(state, job.stableAgentId), job) }) });
    if (stopped('lineageRemovedAt')) return await readJob(db, scopeId, jobId);

    // The rows outside the scope JSON go last, so the receptionist stays listed as "Deleting" until everything else is gone.
    const current = await readJob(db, scopeId, jobId);
    if (!current.phases.recordsRemovedAt) {
      try { await inOwnerScope(db, scopeId, (tx) => tx.query('SELECT delete_receptionist_records($1::uuid,$2::uuid) AS removed', [scopeId, start.stableAgentId])); }
      catch (cause) { throw stage(DELETION_FAILURES.records, cause); }
    }
    await runPhase({ ...at, phase: 'recordsRemovedAt', change: () => ({}) });
    if (stopped('recordsRemovedAt')) return await readJob(db, scopeId, jobId);

    return await withOwnerState(db, scopeId, (state) => {
      const job = state.receptionistDeletions[jobId];
      const done = { ...job, status: 'completed', failureCode: null, completedAt: job.completedAt ?? iso(now()), updatedAt: iso(now()) };
      return { result: done, state: withJob(state, done) };
    });
  } catch (error) {
    const code = typeof error?.failureCode === 'string' ? error.failureCode : DELETION_FAILURES.other;
    await markFailed({ db, scopeId, jobId, code, now });
    return readJob(db, scopeId, jobId);
  }
}

/**
 * One sweep for the retention worker (server/api/retention.js). Resumes every job that is pending, or failed with fewer than
 * three automatic attempts, scope by scope. Returns counts only.
 */
export async function sweepReceptionistDeletions({ db, limit = 50, endLiveCall = null, now = () => new Date() }) {
  const { rows } = await db.query('SELECT list_scopes_with_pending_receptionist_deletions($1::integer) AS scope_id', [limit]);
  let jobs = 0; let completed = 0;
  for (const { scope_id: scopeId } of rows) {
    const due = await withOwnerState(db, scopeId, (state) => ({ result: Object.values(state.receptionistDeletions ?? {}).filter((job) => job.status === 'pending' || (job.status === 'failed' && job.attempts < MAX_AUTOMATIC_ATTEMPTS)).map((job) => job.jobId) }));
    for (const jobId of due) {
      jobs += 1;
      const job = await runReceptionistDeletion({ db, scopeId, jobId, endLiveCall, now });
      if (job?.status === 'completed') completed += 1;
    }
  }
  return { scopes: rows.length, jobs, completed };
}
