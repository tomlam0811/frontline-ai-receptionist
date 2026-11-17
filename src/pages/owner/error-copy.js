import { OwnerApiError } from '../../lib/owner-api.js';

// Server codes to sentences (design spec, Error copy). The UI never shows a raw code, a stack or a provider name.

const LIMIT_TEXT = { input_too_large: 'up to 10,000 characters', upload_too_large: 'up to 5 MB' };

/** True for the two codes that mean "someone saved a newer version". They get the conflict notice, not a sentence. */
export const isConflict = (error) => ['stale_agent_version', 'stale_update'].includes(error?.code);

/**
 * `version` is accepted so existing callers keep working. No sentence mentions a version any more.
 * @param {unknown} error
 * @param {{version?: number|null, fallback?: string}} [options]
 */
export function errorMessage(error, { fallback = "That didn't work. Try again." } = {}) {
  const code = error instanceof OwnerApiError ? error.code : /** @type {any} */ (error)?.code;
  switch (code) {
    case 'input_too_large':
    case 'upload_too_large': return `That's too big. Use ${LIMIT_TEXT[code]}.`;
    case 'unsupported_media_type': return "That kind of file can't be read. Use a PDF, Word or text file.";
    case 'document_encrypted': return 'That file is password protected. Remove the password and try again, or paste the text.';
    case 'document_scanned_only': return 'That file looks like a picture of text. Paste the text instead.';
    case 'document_unreadable': return "Couldn't read that file. Paste the text instead.";
    case 'source_requires_login': return 'That page needs a sign-in. Use a public page or paste the text.';
    case 'source_not_public': return "That address can't be read. Use a public page that starts with https://.";
    case 'extraction_unavailable':
    case 'transcription_unavailable': return "Couldn't read that right now. Try again, or contact the Frontline team if it keeps happening.";
    case 'compile_failed': return "Couldn't save that change. Try again.";
    case 'required_workflow_disabled': return "That one can't be turned off.";
    case 'conflict_unresolved': return 'Choose which item to use first.';
    case 'voice_limit_reached': return 'Calls are paused right now. Please contact the Frontline team.';
    case 'test_limit_reached': return "You've used today's 3 test calls. The limit resets at midnight Pacific time.";
    case 'agent_busy': return 'Another call is in progress. Try again in a few minutes.';
    case 'voice_unavailable': return "Calls aren't available right now. Please contact the Frontline team.";
    case 'share_limit_reached': return 'Limit of 5 unused links reached. Revoke one to create another.';
    case 'rate_limited': return 'Too many tries in a row. Wait a minute, then try again.';
    case 'sign_in_required': return 'Sign in again to continue.';
    case 'feature_disabled': return "This isn't available right now. Please contact the Frontline team.";
    case 'connection_failed': return "Couldn't reach Frontline. Check your connection, then try again.";
    case 'agent_paused':
    case 'needs_knowledge': return /** @type {any} */ (error)?.message || fallback;
    case 'invalid_field': return /** @type {any} */ (error)?.message || fallback;
    default: return fallback;
  }
}
