import { knownVersionIds } from './lineage.js';

// Which sources of the business knowledge library each receptionist uses (multi-receptionist spec MR-D2).
// Pure helpers over the scope state; the routes that use them live in knowledge-updates.js.

export const DEFAULT_RECEPTIONIST_NAME = 'Blake';

/** True when a knowledge update belongs to this receptionist (it was started on one of its versions). Updates without a base belong to everyone. */
export const ownsUpdate = (lineage, update) => !update.baseAgentVersionId || knownVersionIds(lineage).includes(update.baseAgentVersionId);

/** The receptionists whose selection includes a source: `[{ stableAgentId, name }]`, ordered by name then id. */
export function usedByList(state, sourceId) {
  return Object.entries(state.agentLineages ?? {})
    .filter(([, lineage]) => lineage.sourceIds?.includes(sourceId))
    .map(([stableAgentId, lineage]) => ({ stableAgentId, name: lineage.name ?? DEFAULT_RECEPTIONIST_NAME }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.stableAgentId.localeCompare(b.stableAgentId));
}

/** A source an owner can still select: not erased and not being erased. */
export const isSelectableSource = (source) => Boolean(source) && !source.erasedAt && !source.erasureJobId;

/** The sources of entries that became active between two versions of the library. An apply adds these to the receptionist's selection. */
export const sourcesAddedBy = (before, after) => [...new Set(Object.values(after.entries).filter((entry) => entry.state === 'active' && !before.entries[entry.entryId]).map((entry) => entry.sourceId))];
