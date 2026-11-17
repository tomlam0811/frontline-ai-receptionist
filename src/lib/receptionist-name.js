const DEFAULT_NAME = 'Blake';

/**
 * The name owners see for their AI receptionist: the name they chose, or "Blake".
 * The owner summaries carry `name`; an agent without one returns "Blake".
 * @param {{name?: string | null} | null | undefined} [agent]
 */
export function receptionistName(agent) {
  const chosen = typeof agent?.name === 'string' ? agent.name.trim() : '';
  return chosen || DEFAULT_NAME;
}

export const NAME_MAX_LENGTH = 30;
export const INVALID_NAME_MESSAGE = 'Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.';
export const NAME_TAKEN_MESSAGE = 'That name is already used.';

// Letters (any script, with combining marks), spaces, apostrophes and hyphens. The server applies the same rule.
const ALLOWED_NAME = /^[\p{L}\p{M}' ’-]+$/u;

/**
 * Checks a typed receptionist name before it is sent. Returns the sentence to show, or null when the name is fine.
 * @param {string} value
 */
export function receptionistNameProblem(value) {
  const name = String(value ?? '').normalize('NFC').trim();
  const length = [...name].length;
  return length < 1 || length > NAME_MAX_LENGTH || !ALLOWED_NAME.test(name) || !/\p{L}/u.test(name) ? INVALID_NAME_MESSAGE : null;
}
