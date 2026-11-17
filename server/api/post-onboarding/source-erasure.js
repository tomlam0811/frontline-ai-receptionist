import { randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { problem } from './errors.js';
import { backfillKnowledgeLibrary, ensureLineage, publishRevision, readKnowledgeBase, readLineage } from './lineage.js';
import { withOwnerState } from './owner-state.js';
import { receptionistNameOf } from './receptionist-name.js';
import { fenceSource, isCallLive, jobLineages, redactSource, sourceContentRemains, sourceFootprint } from './source-redaction.js';

// Privacy erasure of one knowledge source, "Delete this source everywhere" (PO-A16, PO-E27, ticket TOM-38).
//
// Ordinary Delete of a fact stays a next-revision retraction (knowledge-updates.js). This is the exceptional
// path: Bob forgets the source and its stored content and derived copies are deleted. Past conversations and
// feedback are kept. It has two steps:
//   1. startSourceErasure fences, in one transaction: the affected versions become unavailable for new use,
//      share links pinned to them are revoked, and open updates that would bring the source back are cancelled.
//      It returns a durable job and answers before any cleanup.
//   2. runSourceErasure does the cleanup and can be repeated any number of times: end live calls on the
//      affected versions, erase what the future intake kinds registered, redact the scope JSON, recompile the
//      remaining knowledge, and check that no source content remains. The job is `completed` only after that
//      check. Until then, and after a failure, the affected versions stay fenced.

export const ERASURE_FAILURES = { sessions: 'sessions_not_ended', stores: 'store_cleanup_failed', other: 'cleanup_failed' };
export const MAX_AUTOMATIC_ATTEMPTS = 3;

/**
 * Where a source's bytes and derived copies live outside the owner's scope JSON.
 * Nothing is registered today: website research, owner form edits and owner text keep everything in the scope
 * JSON. An intake kind that stores anything elsewhere (uploaded document or audio bytes, a fetched page copy,
 * a provider-side artifact) must push an eraser here in the same change that adds the storage:
 *   { name: string,
 *     appliesTo(source): boolean,
 *     erase({ scopeId, job, source }): Promise<void> }   // idempotent; throw to keep the job failed and fenced
 * The runner calls each applicable eraser before it redacts the scope JSON, so `source` still has its
 * type, url and filename. tests/post-onboarding/source-erasure.test.js pins this contract.
 */
export const sourceStoreErasers = [];

const invalid = (message) => problem(400, 'invalid_field', message);
const iso = (now) => now.toISOString();

const REMAINING = { published: 'recompiled', not_needed: 'unchanged', not_possible: 'needs_information' };

/** The job as the owner sees it. Ids, timestamps and counts only, never source content. */
export function publicJob(job) {
  return {
    jobId: job.jobId, sourceId: job.sourceId, sourceType: job.sourceType, status: job.status,
    requestedAt: job.requestedAt, updatedAt: job.updatedAt, completedAt: job.completedAt ?? null,
    failureCode: job.failureCode ?? null, retryable: job.status === 'failed',
    versionsAffected: job.affectedVersionIds.length, linksRevoked: job.audit.linksRevoked,
    remainingKnowledge: REMAINING[job.audit.recompile] ?? null,
    backups: 'expire_separately',
  };
}

export const listSourceErasures = (state, stableAgentId) => Object.values(state.sourceErasures ?? {})
  .filter((job) => job.stableAgentId === stableAgentId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.jobId.localeCompare(a.jobId)).slice(0, 20).map(publicJob);

const saveState = (tx, scopeId, state) => tx.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1::uuid', [scopeId, JSON.stringify(state)]);

/**
 * PO-E27 POST. Fences and returns the job (202). A second request for the same source returns the same job;
 * if that job failed, it is set back to `pending` so the cleanup resumes it. `created` and `resumed` say
 * which, so the caller knows whether to start the cleanup.
 */
export async function startSourceErasure({ db, actor, sourceId, body, now = new Date(), newId = /** @type {() => string} */ (() => randomUUID()) }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) throw invalid('confirm: send true to delete this source everywhere.');
  if (!Number.isInteger(body.expectedPointerGeneration)) throw invalid('expectedPointerGeneration: send the value from the page you are viewing.');
  return inOwnerScope(db, actor.scopeId, async (tx) => {
    const raw = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR UPDATE', [actor.scopeId])).rows[0]?.state;
    const ensured = raw && ensureLineage(raw, actor.stableAgentId);
    if (!ensured) throw problem(404, 'not_found', 'Not found.');
    const state = backfillKnowledgeLibrary(ensured, actor.stableAgentId);
    const base = readKnowledgeBase(state, actor.stableAgentId);
    const source = base.sources[sourceId];
    if (!source) throw problem(404, 'not_found', 'Not found.');

    const existing = Object.values(state.sourceErasures ?? {}).find((job) => job.stableAgentId === actor.stableAgentId && job.sourceId === sourceId);
    if (existing) {
      if (existing.status !== 'failed') return { job: publicJob(existing), created: false, resumed: false };
      const resumed = { ...existing, status: 'pending', updatedAt: iso(now) };
      await saveState(tx, actor.scopeId, { ...state, sourceErasures: { ...state.sourceErasures, [existing.jobId]: resumed } });
      return { job: publicJob(resumed), created: false, resumed: true, jobId: existing.jobId };
    }

    const lineage = readLineage(state, actor.stableAgentId);
    if (lineage.pointerGeneration !== body.expectedPointerGeneration) {
      throw Object.assign(problem(409, 'stale_agent_version', `${receptionistNameOf(lineage)} changed since you opened this. Refresh and try again.`), { currentPointerGeneration: lineage.pointerGeneration, currentAgentVersionId: lineage.currentAgentVersionId });
    }
    const footprint = sourceFootprint(state, actor.stableAgentId, source);
    const jobId = newId();
    const job = {
      jobId, stableAgentId: actor.stableAgentId, sourceId, sourceType: source.type, status: 'pending', attempts: 0, failureCode: null,
      requestedAt: iso(now), updatedAt: iso(now), completedAt: null, actorRef: actor.creatorRef ?? null,
      affectedVersionIds: footprint.versionIds, affectedLineages: footprint.lineages, knowledgeRevisionIds: footprint.knowledgeRevisionIds,
      phases: { fencedAt: iso(now), callsEndedAt: null, storesErasedAt: null, redactedAt: null, contentVerifiedAt: null },
      audit: { linksRevoked: 0, recompile: null },
    };
    const revoked = (await tx.query('SELECT * FROM share_fence_versions($1::uuid,$2::uuid[])', [actor.scopeId, job.affectedVersionIds])).rows;
    job.audit = { linksRevoked: revoked.length, recompile: null };
    await saveState(tx, actor.scopeId, fenceSource(state, { stableAgentId: actor.stableAgentId, source, job, now }));
    return { job: publicJob(job), created: true, resumed: false, jobId };
  });
}

/** PO-E27 GET. */
export function getSourceErasure({ db, actor, sourceId, jobId }) {
  return withOwnerState(db, actor.scopeId, (state) => {
    const job = state.sourceErasures?.[jobId];
    if (!job || job.stableAgentId !== actor.stableAgentId || job.sourceId !== sourceId) throw problem(404, 'not_found', 'Not found.');
    return { result: publicJob(job) };
  });
}

const readJob = (db, scopeId, jobId) => withOwnerState(db, scopeId, (state) => ({ result: state.sourceErasures?.[jobId] ?? null }));

async function markFailed({ db, scopeId, jobId, code, now }) {
  await withOwnerState(db, scopeId, (state) => {
    const job = state.sourceErasures?.[jobId];
    if (!job || job.status === 'completed') return { result: null };
    return { result: null, state: { ...state, sourceErasures: { ...state.sourceErasures, [jobId]: { ...job, status: 'failed', failureCode: code, attempts: job.attempts + 1, updatedAt: iso(now()) } } } };
  });
}

const stage = (code, cause) => Object.assign(new Error('erasure stage failed', { cause }), { failureCode: code });

/**
 * Cleanup for one job. Safe to repeat and safe to run twice at once: every stage is a filter or a set-if-unset
 * under the scope lock. It never throws for an expected failure; it records `failed` (still fenced) and returns
 * the job. `endLiveCall` is the terminal path for a live call (the retention worker has none, so a job that
 * still has a live call waits, and the call's own deadline ends it).
 */
export async function runSourceErasure({ db, scopeId, jobId, endLiveCall = null, now = () => new Date(), stores = sourceStoreErasers }) {
  const start = await readJob(db, scopeId, jobId);
  if (!start || start.status === 'completed') return start;
  try {
    // Stragglers: a link created between the fence and now is caught here.
    await inOwnerScope(db, scopeId, (tx) => tx.query('SELECT * FROM share_fence_versions($1::uuid,$2::uuid[])', [scopeId, start.affectedVersionIds]));

    const affectedLineages = jobLineages(start);
    const live = async () => withOwnerState(db, scopeId, (state) => ({ result: Object.values(state.demos ?? {}).filter((demo) => affectedLineages[demo?.stableAgentId]?.includes(demo.agentVersionId) && isCallLive(demo)) }));
    const liveNow = await live();
    if (liveNow.length) {
      if (!endLiveCall) return start;
      for (const demo of liveNow) {
        try { await endLiveCall({ scopeId, demoId: demo.id, sessionId: demo.guestSessionId ?? null, reservationId: demo.reservationId ?? null, reason: 'source_erased' }); }
        catch (cause) { throw stage(ERASURE_FAILURES.sessions, cause); }
      }
      if ((await live()).length) throw stage(ERASURE_FAILURES.sessions);
    }

    const source = await withOwnerState(db, scopeId, (state) => ({ result: readKnowledgeBase(state, start.stableAgentId).sources[start.sourceId] ?? null }));
    if (!start.phases.storesErasedAt) {
      for (const store of stores.filter((item) => item.appliesTo(source))) {
        try { await store.erase({ scopeId, job: start, source }); } catch (cause) { throw stage(ERASURE_FAILURES.stores, cause); }
      }
    }

    return await withOwnerState(db, scopeId, (raw) => {
      const job = raw.sourceErasures[jobId];
      const state = job.phases.redactedAt ? raw : backfillKnowledgeLibrary(raw, job.stableAgentId);
      const at = iso(now());
      let next = state;
      let audit = job.audit;
      if (!job.phases.redactedAt) {
        const base = readKnowledgeBase(state, job.stableAgentId);
        const original = base.sources[job.sourceId];
        const redacted = redactSource(state, { stableAgentId: job.stableAgentId, source: original, job, now: now() });
        next = redacted.state;
        let recompile = 'not_needed';
        // Every receptionist whose current version was built with the source gets a new version without it.
        for (const [stableAgentId, versionIds] of Object.entries(jobLineages(job))) {
          const lineage = readLineage(next, stableAgentId);
          if (!lineage || !versionIds.includes(lineage.currentAgentVersionId)) continue;
          try {
            next = publishRevision(next, { stableAgentId, baseAgentVersionId: lineage.currentAgentVersionId, expectedGeneration: lineage.pointerGeneration, knowledgeBase: redacted.knowledgeBase, allowNoSources: false, kind: 'knowledge', actorSubjectHash: job.actorRef, now: now() }).state;
            if (recompile !== 'not_possible') recompile = 'published';
          } catch (error) {
            if (error?.code !== 'compile_failed') throw error;
            recompile = 'not_possible';
          }
        }
        audit = { ...audit, ...redacted.counts, recompile };
        if (sourceContentRemains(next, job.stableAgentId, original)) throw stage(ERASURE_FAILURES.other);
      }
      const done = {
        ...job, status: 'completed', failureCode: null, completedAt: job.completedAt ?? at, updatedAt: at, audit,
        phases: { ...job.phases, callsEndedAt: job.phases.callsEndedAt ?? at, storesErasedAt: job.phases.storesErasedAt ?? at, redactedAt: job.phases.redactedAt ?? at, contentVerifiedAt: job.phases.contentVerifiedAt ?? at },
      };
      return { result: done, state: { ...next, sourceErasures: { ...next.sourceErasures, [jobId]: done } } };
    });

  } catch (error) {
    const code = typeof error?.failureCode === 'string' ? error.failureCode : ERASURE_FAILURES.other;
    await markFailed({ db, scopeId, jobId, code, now });
    return readJob(db, scopeId, jobId);
  }
}

/**
 * One sweep for the retention worker (connection: server/api/retention.js). Resumes every job that is pending, or
 * failed with fewer than three automatic attempts, scope by scope. Returns counts only.
 */
export async function sweepSourceErasures({ db, limit = 50, endLiveCall = null, now = () => new Date() }) {
  const { rows } = await db.query('SELECT list_scopes_with_pending_source_erasures($1::integer) AS scope_id', [limit]);
  let jobs = 0; let completed = 0;
  for (const { scope_id: scopeId } of rows) {
    const due = await withOwnerState(db, scopeId, (state) => ({ result: Object.values(state.sourceErasures ?? {}).filter((job) => job.status === 'pending' || (job.status === 'failed' && job.attempts < MAX_AUTOMATIC_ATTEMPTS)).map((job) => job.jobId) }));
    for (const jobId of due) {
      jobs += 1;
      const job = await runSourceErasure({ db, scopeId, jobId, endLiveCall, now });
      if (job?.status === 'completed') completed += 1;
    }
  }
  return { scopes: rows.length, jobs, completed };
}
