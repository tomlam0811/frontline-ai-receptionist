import { OwnerApiError } from './owner-api.js';

// Raw uploads for the Knowledge screen (technical spec PO-E9, PO-E10): a document file, or a dictation recording.
// The server routes are planned and not built in the scaffold, so `GET .../knowledge` reports `inputs.document`
// and `inputs.dictation` as false and the screen never offers these until they are. When PO-E9 and PO-E10 are
// built, fold these two calls into owner-api.js so they share its CSRF cache (connection guide, PO-C13).
//
// The CSRF value is read from the fl_csrf cookie (double-submit); it is not HttpOnly by design. /v1/session is
// called only when the cookie is missing, because each call issues a new token.

const readCsrf = () => document.cookie.split('; ').find((part) => part.startsWith('fl_csrf='))?.slice('fl_csrf='.length) ?? '';

async function csrfToken() {
  let token = readCsrf();
  if (!token) {
    await fetch('/v1/session', { credentials: 'include' }).catch(() => null);
    token = readCsrf();
  }
  if (!token) throw new OwnerApiError('Frontline could not be reached.', 'connection_failed', 0);
  return token;
}

async function send(path, { body, headers }) {
  let response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'X-Frontline-CSRF': await csrfToken(), ...headers }, body });
  } catch (error) {
    if (error instanceof OwnerApiError) throw error;
    throw new OwnerApiError('Frontline could not be reached.', 'connection_failed', 0);
  }
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new OwnerApiError(parsed?.detail ?? 'The request could not be completed.', parsed?.title ?? 'request_failed', response.status, parsed);
  return parsed;
}

const agentPath = (agentId) => `/v1/agents/${encodeURIComponent(agentId)}`;

/** @returns {Promise<string>} the upload handle to pass as `uploadHandle` when creating the document update */
export async function uploadKnowledgeDocument(agentId, file) {
  const result = await send(`${agentPath(agentId)}/knowledge-uploads`, { body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name).slice(0, 200) } });
  return result.uploadHandle;
}

/** @returns {Promise<string>} the transcript text, which the owner edits before it is sent as a dictation update */
export async function transcribeDictation(agentId, recording) {
  const upload = await send(`${agentPath(agentId)}/audio-uploads`, { body: recording, headers: { 'Content-Type': recording.type || 'audio/webm' } });
  const result = await send(`${agentPath(agentId)}/transcriptions`, { body: JSON.stringify({ uploadHandle: upload.uploadHandle }), headers: { 'Content-Type': 'application/json' } });
  return String(result.transcript ?? '');
}
