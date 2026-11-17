import { problem } from './errors.js';
import { ensureLineage, readLineage } from './lineage.js';
import { withOwnerState } from './owner-state.js';
import { assertNameFree, parseReceptionistName } from './receptionist-name.js';

/**
 * PATCH /v1/agents/:id/name. Sets the receptionist's name on its lineage. It is not a knowledge or capability change,
 * so it publishes no version and does not move the pointer generation. Sending the current name again is a no-op,
 * which is what makes a retry safe without an idempotency key.
 */
export function renameReceptionist({ db, actor, body }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  const name = parseReceptionistName(body.name);
  return withOwnerState(db, actor.scopeId, (raw) => {
    const state = ensureLineage(raw, actor.stableAgentId);
    if (!state) throw problem(404, 'not_found', 'Not found.');
    const lineage = readLineage(state, actor.stableAgentId);
    assertNameFree(state, actor.stableAgentId, name);
    const result = { stableAgentId: actor.stableAgentId, name };
    if (lineage.name === name) return { result };
    return { result, state: { ...state, agentLineages: { ...state.agentLineages, [actor.stableAgentId]: { ...lineage, name } } } };
  });
}
