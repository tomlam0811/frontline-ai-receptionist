import { problem } from './errors.js';
import { compileOwnerAgent, compileOwnerKnowledge } from './revision-compiler.js';
import { workflowList } from './capabilities.js';
import { defaultId, emptyKnowledgeBase, ONBOARDING_ORIGIN, seedKnowledgeBase } from './knowledge-model.js';
import { receptionistNameOf } from './receptionist-name.js';

// Agent lineage helpers (technical spec PO-TD1, PO-TD2). The lineage lives in the
// owner scope JSONB at state.agentLineages[stableAgentId]. These functions are pure:
// they never mutate the state they are given.

/**
 * Returns the lineage for a stable agent id, or null if the agent is not in this scope.
 * A scope that has not been touched by post-onboarding code yet has no stored lineage;
 * one is derived from the claimed agent so reads work before anything is written.
 */
export function readLineage(state, stableAgentId) {
  const stored = state?.agentLineages?.[stableAgentId];
  if (stored) return stored;
  const agent = state?.agents?.[stableAgentId];
  if (!agent || !state.workspaces?.[agent.workspaceId]) return null;
  return {
    stableAgentId,
    pointerGeneration: 1,
    currentAgentVersionId: stableAgentId,
    revisions: [{
      agentVersionId: stableAgentId, knowledgeRevisionId: agent.knowledgeRevisionId ?? null, parentAgentVersionId: null,
      kind: 'initial', createdAt: agent.createdAt ?? null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null,
    }],
  };
}

/** Returns a new state that contains the stored lineage (creates the initial revision if absent). */
export function ensureLineage(state, stableAgentId) {
  const lineage = readLineage(state, stableAgentId);
  if (!lineage) return null;
  if (state.agentLineages?.[stableAgentId]) return state;
  return { ...state, agentLineages: { ...state.agentLineages, [stableAgentId]: lineage } };
}

export const knownVersionIds = (lineage) => lineage.revisions.map((revision) => revision.agentVersionId);

/** "Version 1" is the initial revision, in creation order. */
export function versionNumbers(lineage) {
  return Object.fromEntries(lineage.revisions.map((revision, index) => [revision.agentVersionId, index + 1]));
}

/** The business name Bob speaks for, taken from the preparation that produced this agent. */
export function businessNameFor(state, stableAgentId) {
  const lineage = readLineage(state, stableAgentId);
  const versions = lineage ? knownVersionIds(lineage) : [stableAgentId];
  const preparation = Object.values(state?.preparations ?? {}).find((item) => versions.includes(item.agentVersionId) && item.profile?.businessName);
  return preparation?.profile?.businessName ?? lineage?.businessName ?? state?.agents?.[stableAgentId]?.businessName ?? null;
}

// ------------------------------------------------------------------ publishing


/**
 * Publishes a new immutable revision (technical spec PO-TD2). Both knowledge apply and capability save call
 * this, so there is one compare-and-swap. The caller runs it inside the scope transaction, so a failure here
 * leaves the state untouched. Returns the next state; the input state is not modified.
 * `knowledgeBase` is the business library when the lineage has `sourceIds` (the snapshot then holds only the selected sources).
 * Pass `sourceIds` to change the selection in the same publish. An empty selection compiles to an empty snapshot unless `allowNoSources` is false. A lineage without `sourceIds` is legacy and compiles all of its own knowledge.
 * @param {any} state
 * @param {{stableAgentId: string, baseAgentVersionId: string, expectedGeneration: number, knowledgeBase: any, sourceIds?: string[], allowNoSources?: boolean, workflows?: any[], kind: 'knowledge'|'capabilities', actorSubjectHash?: string|null, now?: Date, newId?: () => string}} input
 */
export function publishRevision(state, { stableAgentId, baseAgentVersionId, expectedGeneration, knowledgeBase, sourceIds, allowNoSources = true, workflows, kind, actorSubjectHash = null, now = new Date(), newId = defaultId }) {
  const lineage = readLineage(state, stableAgentId);
  if (!lineage) throw problem(404, 'not_found', 'Not found.');
  if (lineage.currentAgentVersionId !== baseAgentVersionId || lineage.pointerGeneration !== expectedGeneration) {
    throw Object.assign(problem(409, 'stale_agent_version', `${receptionistNameOf(lineage)} changed since you opened this. Refresh and try again.`), { currentPointerGeneration: lineage.pointerGeneration, currentAgentVersionId: lineage.currentAgentVersionId });
  }
  const previousAgent = state.agents?.[lineage.currentAgentVersionId];
  if (!previousAgent) throw problem(404, 'not_found', 'Not found.');
  const nextWorkflows = workflows ?? workflowList(previousAgent.capabilityManifest);
  const selection = sourceIds ?? lineage.sourceIds;
  const previous = state.knowledge?.[previousAgent.knowledgeRevisionId];
  const knowledge = compileOwnerKnowledge({
    base: knowledgeBase, previous, reference: selection ? state.knowledge?.[knowledgeBase.materializedFromKnowledgeRevisionId] ?? previous : previous, sourceIds: selection, allowNoSources, workspaceId: previousAgent.workspaceId,
    businessName: businessNameFor(state, stableAgentId), workflows: nextWorkflows, now, newId,
  });
  const agentVersionId = newId();
  const agent = compileOwnerAgent({ previousAgent, agentVersionId, knowledge, workflows: nextWorkflows });
  const nextLineage = {
    ...lineage, ...(selection ? { sourceIds: selection } : {}), pointerGeneration: lineage.pointerGeneration + 1, currentAgentVersionId: agentVersionId,
    revisions: [...lineage.revisions, { agentVersionId, knowledgeRevisionId: knowledge.id, parentAgentVersionId: lineage.currentAgentVersionId, kind, createdAt: now.toISOString(), createdBySubjectHash: actorSubjectHash, lastTestedAt: null, ownerReviewedAt: null }],
  };
  return {
    agentVersionId, pointerGeneration: nextLineage.pointerGeneration,
    state: {
      ...state,
      knowledge: { ...state.knowledge, [knowledge.id]: knowledge },
      agents: { ...state.agents, [agentVersionId]: agent },
      agentLineages: { ...state.agentLineages, [stableAgentId]: nextLineage },
      ...(selection ? { knowledgeLibrary: knowledgeBase } : { knowledgeBases: { ...state.knowledgeBases, [stableAgentId]: knowledgeBase } }),
    },
  };
}

/**
 * The owner's working knowledge: the business library of this scope (`state.knowledgeLibrary`). A scope that still
 * has a per-agent base is backfilled in memory first, so reads work before anything is written and never write.
 */
export function readKnowledgeBase(state, stableAgentId) {
  return backfillKnowledgeLibrary(state, stableAgentId).knowledgeLibrary ?? emptyKnowledgeBase();
}

/** The per-agent base of a lineage that has not been moved into the library yet: the stored base, else one seeded from its current record. */
function legacyKnowledgeBase(state, stableAgentId) {
  const stored = state?.knowledgeBases?.[stableAgentId];
  if (stored) return stored;
  const lineage = readLineage(state, stableAgentId);
  const agent = lineage ? state.agents?.[lineage.currentAgentVersionId] : null;
  return seedKnowledgeBase(agent ? state.knowledge?.[agent.knowledgeRevisionId] : null);
}

/** Sources created before `origin` existed: the ones seeded from the onboarding website have type `website`. */
const withOrigin = (source) => (source.origin || source.type !== 'website' ? source : { ...source, origin: ONBOARDING_ORIGIN });

/**
 * Moves each lineage's per-agent knowledge base (`knowledgeBases[stableAgentId]`) into the scope's business library and
 * gives the lineage `sourceIds`, all of its own sources, so its compiled knowledge does not change. Pure and idempotent:
 * a lineage that already has `sourceIds` is left alone, and a state with nothing to move is returned as the same object.
 * Lineages other than `stableAgentId` are migrated too when they hold a stored base. If two bases hold the same entry or
 * source id, the one already in the library wins.
 */
export function backfillKnowledgeLibrary(state, stableAgentId = null) {
  const legacy = [...new Set([stableAgentId, ...Object.keys(state?.agentLineages ?? {}), ...Object.keys(state?.knowledgeBases ?? {})])]
    .filter((id) => id && readLineage(state, id) && readLineage(state, id).sourceIds === undefined);
  if (!legacy.length) return state;
  const library = { ...emptyKnowledgeBase(), ...state.knowledgeLibrary };
  const merged = { ...library, entries: { ...library.entries }, sources: { ...library.sources }, retractions: [...(library.retractions ?? [])], updates: { ...library.updates } };
  const lineages = { ...state.agentLineages };
  for (const id of legacy) {
    const base = legacyKnowledgeBase(state, id);
    const own = { entries: base.entries ?? {}, sources: base.sources ?? {} };
    for (const [entryId, entry] of Object.entries(own.entries)) if (!(entryId in merged.entries)) merged.entries[entryId] = entry;
    for (const [sourceId, source] of Object.entries(own.sources)) if (!(sourceId in merged.sources)) merged.sources[sourceId] = withOrigin(source);
    const seen = new Set(merged.retractions.map((item) => item.retractionId));
    merged.retractions.push(...(base.retractions ?? []).filter((item) => !seen.has(item.retractionId)));
    for (const [updateId, update] of Object.entries(base.updates ?? {})) if (!(updateId in merged.updates)) merged.updates[updateId] = update;
    merged.materializedFromKnowledgeRevisionId = merged.materializedFromKnowledgeRevisionId ?? base.materializedFromKnowledgeRevisionId ?? null;
    const usable = (sourceId) => sourceId && !own.sources[sourceId]?.erasedAt;
    const sourceIds = [...new Set([...Object.keys(own.sources), ...Object.values(own.entries).map((entry) => entry.sourceId)].filter(usable))];
    lineages[id] = { ...readLineage(state, id), sourceIds };
  }
  const { knowledgeBases, ...rest } = state;
  const remaining = Object.fromEntries(Object.entries(knowledgeBases ?? {}).filter(([id]) => !legacy.includes(id)));
  return { ...rest, ...(Object.keys(remaining).length ? { knowledgeBases: remaining } : {}), knowledgeLibrary: merged, agentLineages: lineages };
}

/** The knowledge record the current revision was compiled from (for the "Not used by Bob" list). */
export function currentKnowledgeRecord(state, stableAgentId) {
  const lineage = readLineage(state, stableAgentId);
  const agent = lineage ? state.agents?.[lineage.currentAgentVersionId] : null;
  return agent ? state.knowledge?.[agent.knowledgeRevisionId] ?? null : null;
}

// ------------------------------------------------------------------ receptionist status (MR-D5, MR-D10)

/** The receptionist's spoken and displayed name: the one on the lineage (see receptionist-name.js), or "Blake". */
export const receptionistNameFor = receptionistNameOf;

/** `active` when the lineage has no stored status. `deleting` starts a delete (receptionist-deletion.js) and is never left. */
export const lineageStatus = (lineage) => lineage?.status ?? 'active';

export const isPaused = (lineage) => lineageStatus(lineage) === 'paused';

export const isDeleting = (lineage) => lineageStatus(lineage) === 'deleting';

/** A receptionist being deleted is gone for every caller: same answer as one that never existed. */
export function assertNotDeleting(lineage) {
  if (isDeleting(lineage)) throw problem(404, 'not_found', 'Not found.');
}

/** Owner-facing refusal for a paused receptionist. Test start and share create use it. */
export function assertNotPaused(lineage) {
  if (isPaused(lineage)) throw problem(409, 'agent_paused', `${receptionistNameFor(lineage)} is paused.`);
}

/**
 * A receptionist needs at least one selected knowledge source to take calls (MR-D10).
 * `sourceIds` arrives with the knowledge selection ticket. While it is undefined the receptionist uses all knowledge.
 */
export const hasSelectedKnowledge = (state, lineage) => (lineage?.sourceIds === undefined ? true : lineage.sourceIds.length > 0);

/** True when the owner has chosen no source for this receptionist. A legacy lineage without `sourceIds` is not in this state. */
export const needsKnowledge = (lineage) => !hasSelectedKnowledge(null, lineage);

/** Owner-facing refusal for a receptionist with no selected source (MR-D10). Test start, share create, guest start and Resume use it. */
export function assertHasKnowledge(state, lineage) {
  if (!hasSelectedKnowledge(state, lineage)) throw problem(409, 'needs_knowledge', `${receptionistNameFor(lineage)} needs knowledge before it can take calls. Choose at least one source.`);
}
