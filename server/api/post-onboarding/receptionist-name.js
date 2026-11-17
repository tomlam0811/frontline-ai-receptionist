import { problem } from './errors.js';

// The receptionist's name (multi-receptionist spec MR-D4). It lives on the lineage
// (state.agentLineages[stableAgentId].name), never on a version, so renaming publishes nothing.
// This file is pure: it validates names and reads them, and never touches storage.

export const DEFAULT_RECEPTIONIST_NAME = 'Blake';
export const RECEPTIONIST_NAME_MAX = 30;

// Letters (any script, with combining marks), spaces, apostrophes and hyphens.
const ALLOWED = /^[\p{L}\p{M}' ’-]+$/u;

export const INVALID_NAME_MESSAGE = 'Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.';
export const NAME_TAKEN_MESSAGE = 'That name is already used.';

/** The name a lineage answers to: the one the owner chose, or "Blake". */
export function receptionistNameOf(lineage) {
  return typeof lineage?.name === 'string' && lineage.name ? lineage.name : DEFAULT_RECEPTIONIST_NAME;
}

/** Case and apostrophe style do not make two names different. */
const keyOf = (name) => name.normalize('NFC').replace(/’/g, "'").toLowerCase();

/**
 * Trims and checks a typed name. Returns the name to store, or throws the owner-facing problem.
 * @param {unknown} value
 */
export function parseReceptionistName(value) {
  if (typeof value !== 'string') throw problem(400, 'invalid_field', 'name: send the new name.');
  const name = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  const length = [...name].length;
  if (length < 1 || length > RECEPTIONIST_NAME_MAX || !ALLOWED.test(name) || !/\p{L}/u.test(name)) throw problem(422, 'invalid_name', INVALID_NAME_MESSAGE);
  return name;
}

/** Throws name_taken when another lineage in this scope already answers to the name (ignoring case). */
export function assertNameFree(state, stableAgentId, name) {
  const wanted = keyOf(name);
  for (const [otherId, other] of Object.entries(state?.agentLineages ?? {})) {
    if (otherId !== stableAgentId && keyOf(receptionistNameOf(other)) === wanted) throw problem(409, 'name_taken', NAME_TAKEN_MESSAGE);
  }
}
