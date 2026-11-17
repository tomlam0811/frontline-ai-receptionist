import { compileGroupedProfile } from '../../research/grouped-profile.js';
import { readKnowledgeBase, readLineage } from './lineage.js';

// Pure functions of the owner's scope JSON for privacy erasure of one knowledge source (PO-A16).
// Nothing here reads a clock or performs I/O. Each redaction is a filter, so applying it twice
// gives the same state, which is what makes an erasure job safe to retry.

const OPEN_UPDATE_STATES = ['extracting', 'needs_confirmation', 'review', 'applying', 'conflict'];
export const isCallLive = (demo) => !['ended', 'failed'].includes(demo?.state);

/** A version is unavailable from the moment an erasure fences it, and stays unavailable once it is redacted. */
export const revisionUnavailable = (revision) => Boolean(revision?.fencedAt || revision?.erasedAt);

export function unavailableVersionIds(lineage) {
  return new Set((lineage?.revisions ?? []).filter(revisionUnavailable).map((revision) => revision.agentVersionId));
}

/** True for a call still in progress on an unavailable version. Finished calls are kept and stay readable. */
export function isCallFenced(state, demo) {
  if (!demo || !isCallLive(demo)) return false;
  const lineage = demo.stableAgentId ? readLineage(state, demo.stableAgentId) : null;
  return Boolean(lineage && unavailableVersionIds(lineage).has(demo.agentVersionId));
}

const holdsSource = (record, source) => Boolean(record)
  && ((record.ownerFacts ?? []).some((fact) => fact.sourceId === source.sourceId)
    || (record.classifiedPassages ?? []).some((passage) => passage.source?.sourceId === source.sourceId)
    || (source.url && ((record.facts ?? []).some((fact) => fact.sourceUrl === source.url) || (record.sources ?? []).some((item) => item.url === source.url))));

/** The affected versions of each receptionist a job covers. Jobs written before the library have one lineage, the requester's. */
export const jobLineages = (job) => job.affectedLineages ?? { [job.stableAgentId]: job.affectedVersionIds };

const withoutSource = (lineage, sourceId) => (lineage.sourceIds?.includes(sourceId) ? { ...lineage, sourceIds: lineage.sourceIds.filter((id) => id !== sourceId) } : lineage);
const touchesJob = (lineage, sourceId, versions) => Boolean(lineage.sourceIds?.includes(sourceId)) || lineage.revisions.some((revision) => versions.has(revision.agentVersionId));

/**
 * What a source has reached in this scope, taken before anything is changed so the job can name it later:
 * the knowledge records built from it and, for every receptionist in the scope, the agent versions pinned to those
 * records. `lineages` always includes the requester; `versionIds` lists all of them.
 */
export function sourceFootprint(state, stableAgentId, source) {
  const knowledgeRevisionIds = Object.entries(state.knowledge ?? {}).filter(([, record]) => holdsSource(record, source)).map(([id]) => id);
  const revisionIds = new Set(knowledgeRevisionIds);
  const lineages = {};
  for (const id of [stableAgentId, ...Object.keys(state.agentLineages ?? {})]) {
    const lineage = readLineage(state, id);
    const versionIds = (lineage?.revisions ?? []).filter((revision) => revisionIds.has(revision.knowledgeRevisionId)).map((revision) => revision.agentVersionId);
    if (id === stableAgentId || versionIds.length) lineages[id] = versionIds;
  }
  return { knowledgeRevisionIds, versionIds: Object.values(lineages).flat(), lineages };
}

const timestamp = (now) => now.toISOString();

/**
 * The fence. Marks the affected versions unavailable, takes the source's entries out of every future compile,
 * and cancels open updates that would bring the source back. Content is not removed yet.
 */
export function fenceSource(state, { stableAgentId, source, job, now }) {
  const base = readKnowledgeBase(state, stableAgentId);
  const versions = new Set(job.affectedVersionIds);
  const lineages = Object.fromEntries(Object.entries({ ...state.agentLineages, [stableAgentId]: readLineage(state, stableAgentId) }).map(([id, lineage]) => [id, !touchesJob(lineage, source.sourceId, versions) ? lineage : {
    ...withoutSource(lineage, source.sourceId),
    revisions: lineage.revisions.map((revision) => (versions.has(revision.agentVersionId) && !revision.fencedAt ? { ...revision, fencedAt: timestamp(now), erasureJobId: job.jobId } : revision)),
  }]));
  const entries = Object.fromEntries(Object.entries(base.entries).map(([id, entry]) => [id, entry.sourceId === source.sourceId && entry.state === 'active' ? { ...entry, state: 'retracted', updatedAt: timestamp(now) } : entry]));
  const updates = Object.fromEntries(Object.entries(base.updates).map(([id, update]) => [id, OPEN_UPDATE_STATES.includes(update.state) && update.candidates.some((candidate) => candidate.sourceId === source.sourceId) ? { ...update, state: 'cancelled', version: update.version + 1, updatedAt: timestamp(now) } : update]));
  const sources = { ...base.sources, [source.sourceId]: { ...base.sources[source.sourceId], erasureJobId: job.jobId } };
  return {
    ...state,
    agentLineages: lineages,
    knowledgeLibrary: { ...base, entries, updates, sources },
    sourceErasures: { ...state.sourceErasures, [job.jobId]: job },
  };
}

function redactKnowledgeRecord(record, source, now) {
  const erasedPassageIds = new Set((record.classifiedPassages ?? []).filter((passage) => passage.source?.sourceId === source.sourceId).map((passage) => passage.passageId));
  const groupedFacts = (record.groupedFacts ?? []).filter((fact) => !(fact.passageIds ?? []).some((id) => erasedPassageIds.has(id)));
  const classifiedPassages = (record.classifiedPassages ?? []).filter((passage) => !erasedPassageIds.has(passage.passageId));
  const facts = (record.facts ?? []).filter((fact) => !(source.url && fact.sourceUrl === source.url));
  const ownerFacts = (record.ownerFacts ?? []).filter((fact) => fact.sourceId !== source.sourceId);
  const sources = (record.sources ?? []).filter((item) => !(source.url && item.url === source.url));
  const next = { ...record, groupedFacts, classifiedPassages, facts, sources, ...(record.ownerFacts ? { ownerFacts } : {}), erasedAt: record.erasedAt ?? timestamp(now) };
  if (record.groupedProfile) {
    const rebuilt = compileGroupedProfile(groupedFacts, classifiedPassages, record.groupedProfile.createdAt);
    next.groupedProfile = { ...rebuilt, knowledgeRevisionId: record.groupedProfile.knowledgeRevisionId, profileRevisionId: record.groupedProfile.profileRevisionId, businessId: record.groupedProfile.businessId, capabilities: record.groupedProfile.capabilities };
  }
  return next;
}

function redactPreparation(preparation, source, erasedPassageIds, now) {
  const next = { ...preparation, erasedAt: preparation.erasedAt ?? timestamp(now) };
  if (preparation.profile && source.url) {
    next.profile = {
      ...preparation.profile,
      services: (preparation.profile.services ?? []).filter((service) => service.sourceUrl !== source.url),
      hours: preparation.profile.hours?.sourceUrl === source.url ? null : preparation.profile.hours ?? null,
      sources: (preparation.profile.sources ?? []).filter((item) => item.url !== source.url),
    };
  }
  if (preparation.groupedFacts) {
    const erasedFactIds = new Set(preparation.groupedFacts.filter((fact) => (fact.passageIds ?? []).some((id) => erasedPassageIds.has(id))).map((fact) => fact.factId));
    next.groupedFacts = preparation.groupedFacts.filter((fact) => !erasedFactIds.has(fact.factId));
    if (preparation.groupedProfile) {
      const groups = Object.fromEntries(Object.entries(preparation.groupedProfile.groups ?? {}).map(([key, ids]) => [key, ids.filter((id) => !erasedFactIds.has(id))]));
      next.groupedProfile = { ...preparation.groupedProfile, groups, sourcePassageIds: (preparation.groupedProfile.sourcePassageIds ?? []).filter((id) => !erasedPassageIds.has(id)) };
    }
  }
  return next;
}

/**
 * Removes the source's content from the scope, everywhere it was kept: the working knowledge, every knowledge
 * record built from it and the preparation record. Conversations are not touched: their records, results and
 * receipts stay as they were, pinned to the version they ran on. Returns the next state and counts (no content)
 * for the audit record.
 */
export function redactSource(state, { stableAgentId, source, job, now }) {
  const base = readKnowledgeBase(state, stableAgentId);
  const versions = new Set(job.affectedVersionIds);
  const knowledgeIds = new Set(job.knowledgeRevisionIds);

  const removedEntryIds = new Set(Object.values(base.entries).filter((entry) => entry.sourceId === source.sourceId).map((entry) => entry.entryId));
  const entries = Object.fromEntries(Object.entries(base.entries).filter(([id]) => !removedEntryIds.has(id)).map(([id, entry]) => [id, removedEntryIds.has(entry.supersedesEntryId) ? { ...entry, supersedesEntryId: null } : entry]));
  const retractions = base.retractions.filter((item) => !removedEntryIds.has(item.entryId));
  const updates = Object.fromEntries(Object.entries(base.updates).map(([id, update]) => {
    if (!(update.candidates ?? []).some((candidate) => candidate.sourceId === source.sourceId)) return [id, update];
    return [id, { ...update, state: OPEN_UPDATE_STATES.includes(update.state) ? 'cancelled' : update.state, candidates: update.candidates.filter((candidate) => candidate.sourceId !== source.sourceId), inputRef: {}, sourceErased: true }];
  }));
  const erasedSource = { sourceId: source.sourceId, type: source.type, label: '', excerpt: '', url: null, filename: null, contentHash: '', addedAt: source.addedAt, erasedAt: source.erasedAt ?? timestamp(now), erasureJobId: job.jobId };
  const knowledgeBase = { ...base, entries, retractions, updates, sources: { ...base.sources, [source.sourceId]: erasedSource } };

  const knowledge = Object.fromEntries(Object.entries(state.knowledge ?? {}).map(([id, record]) => [id, knowledgeIds.has(id) ? redactKnowledgeRecord(record, source, now) : record]));
  const erasedPassageIds = new Set(Object.entries(state.knowledge ?? {}).filter(([id]) => knowledgeIds.has(id)).flatMap(([, record]) => (record.classifiedPassages ?? []).filter((passage) => passage.source?.sourceId === source.sourceId).map((passage) => passage.passageId)));
  const preparations = Object.fromEntries(Object.entries(state.preparations ?? {}).map(([id, item]) => [id, (versions.has(item.agentVersionId) || knowledgeIds.has(item.knowledgeRevisionId)) ? redactPreparation(item, source, erasedPassageIds, now) : item]));
  const lineages = Object.fromEntries(Object.entries({ ...state.agentLineages, [stableAgentId]: readLineage(state, stableAgentId) }).filter(([, lineage]) => lineage).map(([id, lineage]) => [id, !touchesJob(lineage, source.sourceId, versions) ? lineage : {
    ...withoutSource(lineage, source.sourceId),
    revisions: lineage.revisions.map((revision) => (versions.has(revision.agentVersionId) && !revision.erasedAt ? { ...revision, erasedAt: timestamp(now) } : revision)),
  }]));

  const next = { ...state, knowledge, preparations, agentLineages: lineages, knowledgeLibrary: knowledgeBase };
  return { state: next, counts: { entries: removedEntryIds.size, knowledgeRecords: knowledgeIds.size, versions: versions.size }, knowledgeBase };
}

/** The completion check: true while anything the source contributed is still in the owner's scope. */
export function sourceContentRemains(state, stableAgentId, source) {
  const base = readKnowledgeBase(state, stableAgentId);
  if (Object.values(base.entries).some((entry) => entry.sourceId === source.sourceId)) return true;
  if (Object.values(base.updates).some((update) => (update.candidates ?? []).some((candidate) => candidate.sourceId === source.sourceId))) return true;
  const profileHolds = (profile) => Boolean(source.url && profile
    && ((profile.services ?? []).some((service) => service.sourceUrl === source.url) || profile.hours?.sourceUrl === source.url || (profile.sources ?? []).some((item) => item.url === source.url)));
  return Object.values(state.knowledge ?? {}).some((record) => holdsSource(record, source))
    || Object.values(state.preparations ?? {}).some((item) => holdsSource(item, source) || profileHolds(item.profile));
}
