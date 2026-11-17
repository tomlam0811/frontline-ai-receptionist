// Client for the owner and guest endpoints (technical spec, Endpoint contracts). It follows the same
// rules as frontline-api.js (CSRF double-submit, credentials included) and adds an idempotency key
// to every write that the server requires one for. A retry of the same action reuses its key.

export class OwnerApiError extends Error {
  /** @param {string} message @param {string} code @param {number} status @param {any} [body] */
  constructor(message, code, status, body = null) {
    super(message);
    this.name = 'OwnerApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

let csrfToken = null;
let sessionRequest = null;

async function parse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new OwnerApiError(body?.detail ?? 'The request could not be completed.', body?.title ?? 'request_failed', response.status, body);
  return { body, headers: response.headers };
}

async function csrf() {
  if (csrfToken) return csrfToken;
  sessionRequest ??= fetch('/v1/session', { credentials: 'include' })
    .then(async (response) => {
      const { body } = await parse(response);
      if (typeof body?.csrfToken !== 'string') throw new OwnerApiError('The session could not start.', 'session_invalid', 502);
      csrfToken = body.csrfToken;
      return csrfToken;
    })
    .catch((error) => { throw error instanceof OwnerApiError ? error : new OwnerApiError('Frontline could not be reached.', 'connection_failed', 0); })
    .finally(() => { sessionRequest = null; });
  return sessionRequest;
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/** @param {string} path @param {{method?: string, body?: unknown, key?: string, signal?: AbortSignal, guest?: boolean}} [options] */
async function call(path, { method = 'GET', body, key, signal, guest = false } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (guest) headers['X-Frontline-Guest'] = '1';
  else headers['X-Frontline-CSRF'] = await csrf();
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, { method, credentials: 'include', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new OwnerApiError('Frontline could not be reached.', 'connection_failed', 0);
  }
  try {
    const { body: parsed, headers: responseHeaders } = await parse(response);
    return Object.assign(parsed, { replayed: responseHeaders.get('idempotent-replay') === 'true' });
  } catch (error) {
    if (error?.code === 'csrf_failed') csrfToken = null;
    throw error;
  }
}

const agent = (id) => `/v1/agents/${encodeURIComponent(id)}`;
/** @param {Record<string, unknown>} params */
const query = (params) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== '').map(([name, value]) => [name, String(value)]));
  return search.size ? `?${search}` : '';
};

export const ownerApi = {
  listMyAgents: (signal) => call('/v1/me/agents', { signal }),
  deleteAccount: (signal) => call('/v1/me/account', { method: 'DELETE', signal }),
  getSummary: (id, signal) => call(`${agent(id)}/summary`, { signal }),
  recordFirstVisit: (id, outcome, signal) => call(`${agent(id)}/first-visit`, { method: 'POST', body: { outcome }, signal }),
  createReceptionist: (body, key, signal) => call('/v1/me/agents', { method: 'POST', body, key, signal }),
  renameReceptionist: (id, name, signal) => call(`${agent(id)}/name`, { method: 'PATCH', body: { name }, signal }),
  getKnowledge: (id, signal) => call(`${agent(id)}/knowledge`, { signal }),
  createKnowledgeUpdate: (id, body, key, signal) => call(`${agent(id)}/knowledge-updates`, { method: 'POST', body, key, signal }),
  getKnowledgeUpdate: (id, updateId, signal) => call(`${agent(id)}/knowledge-updates/${updateId}`, { signal }),
  applyKnowledgeUpdate: (id, updateId, body, key, signal) => call(`${agent(id)}/knowledge-updates/${updateId}/apply`, { method: 'POST', body, key, signal }),
  cancelKnowledgeUpdate: (id, updateId, expectedVersion, signal) => call(`${agent(id)}/knowledge-updates/${updateId}/cancel`, { method: 'POST', body: { expectedVersion }, signal }),
  reopenKnowledgeUpdate: (id, updateId, signal) => call(`${agent(id)}/knowledge-updates/${updateId}/reopen`, { method: 'POST', body: {}, signal }),
  saveKnowledgeSelection: (id, { sourceIds, expectedAgentVersionId }, key, signal) => call(`${agent(id)}/knowledge-sources-selection`, { method: 'PUT', body: { sourceIds, expectedAgentVersionId }, key, signal }),
  eraseSource: (id, sourceId, expectedPointerGeneration, signal) => call(`${agent(id)}/knowledge-sources/${encodeURIComponent(sourceId)}/erase`, { method: 'POST', body: { confirm: true, expectedPointerGeneration }, signal }),
  getCapabilities: (id, signal) => call(`${agent(id)}/capabilities`, { signal }),
  saveCapabilities: (id, body, key, signal) => call(`${agent(id)}/capabilities`, { method: 'PATCH', body, key, signal }),
  submitFeedback: (id, body, key, signal) => call(`${agent(id)}/feedback`, { method: 'POST', body, key, signal }),
  startTest: (id, expectedAgentVersionId, signal) => call(`${agent(id)}/tests`, { method: 'POST', body: { expectedAgentVersionId }, signal }),
  getTestResult: (id, demoId, signal) => call(`${agent(id)}/tests/${demoId}/result`, { signal }),
  endTest: (id, demoId, signal) => call(`${agent(id)}/tests/${demoId}/end`, { method: 'POST', body: {}, signal }),
  deleteAgent: (id, signal) => call(agent(id), { method: 'DELETE', signal }),
  pauseAgent: (id, signal) => call(`${agent(id)}/pause`, { method: 'POST', body: {}, signal }),
  resumeAgent: (id, signal) => call(`${agent(id)}/resume`, { method: 'POST', body: {}, signal }),
  markReviewed: (id, versionId, expectedPointerGeneration, signal) => call(`${agent(id)}/versions/${versionId}/review`, { method: 'POST', body: { expectedPointerGeneration }, signal }),
  listShares: (id, signal) => call(`${agent(id)}/shares`, { signal }),
  createShare: (id, expectedAgentVersionId, key, signal) => call(`${agent(id)}/shares`, { method: 'POST', body: { expectedAgentVersionId }, key, signal }),
  revokeShare: (id, shareId, expectedVersion, signal) => call(`${agent(id)}/shares/${shareId}${query({ expectedVersion })}`, { method: 'DELETE', signal }),
  listConversations: (id, /** @type {{cursor?: string, limit?: number}} */ { cursor, limit } = {}, signal) => call(`${agent(id)}/conversations${query({ cursor, limit })}`, { signal }),
  getConversation: (id, conversationId, signal) => call(`${agent(id)}/conversations/${conversationId}`, { signal }),
  /** VA-D13. `reviewStatus` is 'done' or 'needs_review'. Returns the updated record. */
  reviewOutcome: (id, conversationId, recordId, reviewStatus, signal) => call(`${agent(id)}/conversations/${encodeURIComponent(conversationId)}/outcomes/${encodeURIComponent(recordId)}/review`, { method: 'POST', body: { reviewStatus }, signal }),
  logout: (signal) => call('/v1/auth/logout', { method: 'POST', body: {}, signal }),
};

// Guests have no CSRF pair. Their cookie is SameSite=Strict and every write carries a custom header.
export const guestApi = {
  exchange: (token, signal) => call('/v1/shared/exchange', { method: 'POST', body: { token }, guest: true, signal }),
  start: (signal) => call('/v1/shared/start', { method: 'POST', guest: true, signal }),
  session: (signal) => call('/v1/shared/session', { guest: true, signal }),
  reconnect: (signal) => call('/v1/shared/reconnect', { method: 'POST', guest: true, signal }),
  end: (signal) => call('/v1/shared/end', { method: 'POST', guest: true, signal }),
  result: (signal) => call('/v1/shared/result', { guest: true, signal }),
  feedback: (body, key, signal) => call('/v1/shared/feedback', { method: 'POST', body, key, guest: true, signal }),
};

/** For tests: forget the cached CSRF token. */
export const resetOwnerApi = () => { csrfToken = null; sessionRequest = null; };
