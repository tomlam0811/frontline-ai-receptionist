import { compileGroupedProfile } from '../../research/grouped-profile.js';
import { problem } from './errors.js';
import { activeEntries, defaultId } from './knowledge-model.js';
import { assertRequiredWorkflowsEnabled, constraintsFor } from './capabilities.js';

// Compiles the owner's working knowledge into the immutable knowledge and agent records
// that calls read (technical spec PO-TD2 step 3). Pure: no I/O, ids come from `newId`.

const fail = (detailCode, message) => Object.assign(problem(422, 'compile_failed', message), { detailCode });
const keyOf = (value, url) => `${String(value)}|${url ?? ''}`;

/**
 * Builds the next knowledge record from the working base and the record it replaces.
 * Website facts stay in the original shapes (`facts`, `groupedFacts`, `groupedProfile`) minus anything the owner
 * removed or replaced. Owner facts are kept apart in `ownerFacts`, so no owner text ever enters a
 * structure whose contract says "quoted from a public website".
 */
export function compileOwnerKnowledge({ base, previous, reference = previous, sourceIds, allowNoSources = true, workspaceId, businessName, workflows, now = new Date(), newId = defaultId }) {
  if (!businessName) throw fail('no_business_name', 'Blake needs a business name before knowledge can change.');
  // `sourceIds` is the receptionist's selection from the business library. Undefined means a legacy receptionist that
  // uses all of its own knowledge. `reference` is the record the website facts come from, so a source that was
  // deselected and is selected again brings its facts back.
  const selected = sourceIds ? new Set(sourceIds) : null;
  const chosen = (sourceId) => !selected || selected.has(sourceId);
  const urlsOf = (wanted) => new Set(Object.values(base.sources ?? {}).filter((source) => source.url && chosen(source.sourceId) === wanted).map((source) => source.url));
  const unusedUrls = selected ? urlsOf(false) : new Set();
  const usedUrls = selected ? urlsOf(true) : new Set();
  const droppedUrl = (url) => unusedUrls.has(url) && !usedUrls.has(url);
  const active = activeEntries(base).filter((entry) => chosen(entry.sourceId));
  // A receptionist with no selected source can exist (it needs knowledge before it takes calls), unless the caller says a version must hold knowledge.
  if (!(allowNoSources && selected?.size === 0) && !active.some((entry) => entry.group === 'services')) throw fail('no_services', 'Blake needs at least one service.');
  assertRequiredWorkflowsEnabled(workflows);

  const retiredWebsite = new Set(Object.values(base.entries).filter((entry) => entry.origin === 'website' && entry.state === 'retracted').map((entry) => keyOf(entry.value, base.sources[entry.sourceId]?.url)));
  const keptWebsite = new Set(active.filter((entry) => entry.origin === 'website').map((entry) => keyOf(entry.value, base.sources[entry.sourceId]?.url)));
  const isRetired = (key) => retiredWebsite.has(key) && !keptWebsite.has(key);

  const passageById = new Map((reference?.classifiedPassages ?? []).map((passage) => [passage.passageId, passage]));
  const sourceOfFact = (fact) => base.entries[fact.factId]?.sourceId ?? (fact.passageIds ?? []).map((id) => passageById.get(id)).find(Boolean)?.source?.sourceId ?? fact.passageIds?.[0];
  const groupedFacts = (reference?.groupedFacts ?? []).filter((fact) => base.entries[fact.factId]?.state !== 'retracted' && chosen(sourceOfFact(fact)));
  const passageIds = new Set(groupedFacts.flatMap((fact) => fact.passageIds));
  const classifiedPassages = (reference?.classifiedPassages ?? []).filter((passage) => passageIds.has(passage.passageId));
  const facts = (reference?.facts ?? []).filter((fact) => !isRetired(keyOf(fact.value, fact.sourceUrl)) && !droppedUrl(fact.sourceUrl));
  const ownerFacts = active.filter((entry) => entry.origin !== 'website').map((entry) => {
    const source = base.sources[entry.sourceId];
    return {
      id: entry.entryId, group: entry.group, category: entry.category, value: entry.value, scope: entry.scope, sourceId: entry.sourceId, sourceType: source?.type ?? entry.origin,
      sourceUrl: source?.url ?? null, evidence: source?.erasedAt ? null : source?.excerpt ?? null, attestation: 'owner', status: 'eligible_for_demo', addedAt: entry.createdAt,
    };
  });

  // The revision ids must change on every publish. The profile fingerprint only covers website facts,
  // so an owner-only edit would otherwise reuse the previous ids.
  const profile = compileGroupedProfile(groupedFacts, classifiedPassages, now.toISOString());
  const knowledgeRevisionId = newId();
  const profileRevisionId = newId();
  const groupedProfile = { ...profile, knowledgeRevisionId, profileRevisionId, capabilities: workflows.map(({ workflowId, enabled, allowedToolIds }) => ({ workflowId, enabled, allowedToolIds })) };
  return { id: knowledgeRevisionId, workspaceId, facts, ownerFacts, groupedFacts, groupedProfile, classifiedPassages, sources: (reference?.sources ?? []).filter((item) => !droppedUrl(item.url)), expiresAt: previous?.expiresAt ?? null };
}

/** The agent record for a new revision. It keeps the existing agent shape and adds only the constraints. */
export function compileOwnerAgent({ previousAgent, agentVersionId, knowledge, workflows }) {
  const manifest = { ...(previousAgent?.capabilityManifest ?? {}) };
  manifest.workflowCapabilities = workflows.map(({ workflowId, enabled, allowedToolIds }) => ({ workflowId, enabled, allowedToolIds }));
  manifest.profileRevisionId = knowledge.groupedProfile.profileRevisionId;
  manifest.constraints = constraintsFor(workflows);
  return {
    id: agentVersionId, workspaceId: previousAgent.workspaceId, knowledgeRevisionId: knowledge.id, profileRevisionId: knowledge.groupedProfile.profileRevisionId,
    capabilityManifest: manifest, expiresAt: previousAgent.expiresAt ?? null, createdAt: previousAgent.createdAt ?? null,
  };
}
