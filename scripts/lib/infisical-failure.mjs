// Classifies a failed Infisical CLI run into a fixed category with fixed recovery text.
// CLI output can contain identifiers and URLs, so callers print only the category, its
// recovery text, and setting names from the allowlist below. Never echo CLI output.

export const KNOWN_SETTING_NAMES = ['EXA_API_KEY', 'FRONTLINE_EXA_DAILY_MAX_PREPARATIONS', 'DATABASE_URL'];

const SANDBOX_NOTE = 'A sandboxed agent process may be unable to use the Infisical session or keyring, so run this command outside the sandbox. Log in again only if "infisical login status" also fails outside the sandbox.';

export const RECOVERY = {
  'cli-missing': 'The Infisical CLI is not on PATH. Install it, then run "infisical login" once in a normal terminal.',
  'credential-store-unavailable': `The Infisical credential store (OS keychain) is not accessible from this process. ${SANDBOX_NOTE}`,
  'not-authenticated': `No usable Infisical session in this process. ${SANDBOX_NOTE}`,
  'wrong-project': 'The linked Infisical project was not found. Check that .infisical.json points at the Frontline Secret Manager project.',
  'wrong-environment': 'The Development environment ("dev") was not found in the linked project. Check that the project has a "dev" environment.',
  'access-denied': 'The signed-in identity cannot read Frontline Development settings. Ask the project owner for read access to the dev environment only.',
  'service-unreachable': 'Infisical could not be reached. Check the network connection, then retry.',
  'config-incomplete': 'Development settings are missing or invalid (names listed above). Fix them in the Frontline Development environment in Infisical.',
  'timed-out': 'The Infisical CLI did not answer in time. It may be waiting for an interactive prompt. Run "infisical login status" outside the sandbox, then retry.',
  unknown: 'Infisical failed for a reason this launcher does not recognize. Run "infisical login status" outside the sandbox and retry. Report the category, not the CLI text.',
};

/** @param {{ output?: string, spawnErrorCode?: string, timedOut?: boolean }} [failure] */
export function classifyInfisicalFailure({ output = '', spawnErrorCode, timedOut = false } = {}) {
  const text = String(output).toLowerCase();
  let category = 'unknown';
  if (spawnErrorCode === 'ENOENT') category = 'cli-missing';
  else if (/missing or invalid settings:/.test(text)) category = 'config-incomplete';
  else if (/keyring|keychain|secret ?service|user interaction is not allowed|dbus/.test(text)) category = 'credential-store-unavailable';
  else if (/status-code=403|forbidden|access denied|not allowed to access|insufficient permission/.test(text)) category = 'access-denied';
  else if (/environment[^\n]*not found|environment slug/.test(text)) category = 'wrong-environment';
  else if (/project[^\n]*not found|project with id|bot lookup/.test(text)) category = 'wrong-project';
  else if (/econnrefused|no such host|dial tcp|i\/o timeout|network is unreachable|status-code=5\d\d|could not resolve/.test(text)) category = 'service-unreachable';
  else if (/not authenticated|no valid login session|logged[- ]in|log ?in flow|status-code=401|unauthenticated|unauthorized|token[^\n]*(expired|invalid)|expired/.test(text)) category = 'not-authenticated';
  else if (timedOut) category = 'timed-out';
  return { category, recovery: RECOVERY[category] };
}

/** Returns only allowlisted setting names from the config check's own message. */
export function missingSettingNames(output = '') {
  const match = /missing or invalid settings:\s*([^\n]*)/i.exec(String(output));
  if (!match) return [];
  return KNOWN_SETTING_NAMES.filter((name) => match[1].includes(name));
}
