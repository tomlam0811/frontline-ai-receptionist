let csrfToken = null;
let sessionRequest = null;

export class FrontlineApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'FrontlineApiError';
    this.code = code;
    this.status = status;
  }
}

export function preparationErrorStage(code) {
  return ({
    research_unavailable: 'research_unavailable',
    inspection_unavailable: 'inspection_unavailable',
    connection_failed: 'connection_failed',
    origin_mismatch: 'origin_mismatch',
    rate_limited: 'research_busy',
    inspection_busy: 'research_busy',
  })[code] || 'failed_retryable';
}

async function parseResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.title || body?.error || 'request_failed';
    const knownMessages = {
      research_unavailable: 'Website research is not configured for this app yet. Please try again after setup.',
      inspection_unavailable: 'Website research is temporarily unavailable. Please try again shortly.',
      inspection_failed: 'We could not read that website. Check the address or try another page.',
      origin_mismatch: 'This Frontline preview is not connected to the API that handles website research.',
      rate_limited: 'Website research is busy right now. Please try again shortly.',
      inspection_busy: 'A website check is already in progress. Please wait a moment and try again.',
    };
    throw new FrontlineApiError(
      knownMessages[code] || body?.detail || body?.message || 'The request could not be completed. Please try again.',
      code,
      response.status,
    );
  }
  return body;
}

async function session() {
  if (csrfToken) return csrfToken;
  if (!sessionRequest) {
    sessionRequest = fetch('/v1/session', { credentials: 'include' })
      .then(parseResponse)
      .then((body) => {
        if (typeof body?.csrfToken !== 'string') throw new FrontlineApiError('The session could not start. Please refresh and try again.', 'session_invalid', 502);
        csrfToken = body.csrfToken;
        return csrfToken;
      })
      .catch((error) => {
        if (error instanceof FrontlineApiError || error?.name === 'AbortError') throw error;
        throw new FrontlineApiError('Frontline could not be reached. Check your connection and try again.', 'connection_failed', 0);
      })
      .finally(() => { sessionRequest = null; });
  }
  return sessionRequest;
}

/** @param {string} path @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options] */
async function scopedRequest(path, { method = 'GET', body, signal } = {}) {
  const token = await session();
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      headers: {
        'X-Frontline-CSRF': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new FrontlineApiError('Frontline could not be reached. Check your connection and try again.', 'connection_failed', 0);
  }
  try {
    return await parseResponse(response);
  } catch (error) {
    if (error?.code === 'csrf_failed') csrfToken = null;
    throw error;
  }
}

export const frontlineApi = {
  createPreparation: (url, signal) => scopedRequest('/v1/preparations', { method: 'POST', body: { url }, signal }),
  getPreparation: (id, signal) => scopedRequest(`/v1/preparations/${encodeURIComponent(id)}`, { signal }),
  startDemo: (preparationId, expectedRevision, mode, signal) => scopedRequest('/v1/demos', { method: 'POST', body: { preparationId, expectedRevision, mode }, signal }),
  getDemo: (id, signal) => scopedRequest(`/v1/demos/${encodeURIComponent(id)}`, { signal }),
  getDemoResult: (id, signal) => scopedRequest(`/v1/demos/${encodeURIComponent(id)}/result`, { signal }),
  endDemo: (id, signal) => scopedRequest(`/v1/demos/${encodeURIComponent(id)}/end`, { method: 'POST', body: {}, signal }),
  getClaimIntent: (demoId, signal) => scopedRequest(`/v1/claim-intents?demoId=${encodeURIComponent(demoId)}`, { signal }),
  startGoogleClaim: (claimIntentId, signal) => scopedRequest('/v1/auth/google/start', { method: 'POST', body: { claimIntentId, consent: true }, signal }),
  reauthGoogle: (resourceKind, resourceId, signal) => scopedRequest('/v1/auth/google/reauth', { method: 'POST', body: { resourceKind, resourceId }, signal }),
  signInGoogle: (signal) => scopedRequest('/v1/auth/google/signin', { method: 'POST', body: {}, signal }),
  completeClaim: (claimIntentId, signal) => scopedRequest('/v1/claims', { method: 'POST', body: { claimIntentId }, signal }),
  getAgent: (agentId, signal) => scopedRequest(`/v1/agents/${encodeURIComponent(agentId)}`, { signal }),
  saveAgentSetup: (agentId, setup, signal) => scopedRequest(`/v1/agents/${encodeURIComponent(agentId)}/setup`, { method: 'PATCH', body: setup, signal }),
  getWorkspace: (workspaceId, signal) => scopedRequest(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, { signal }),
  getOwnerHistory: (resourceKind, resourceId, signal) => {
    if (!['agent', 'workspace'].includes(resourceKind)) throw new FrontlineApiError('The saved resource could not be identified.', 'invalid_resource', 400);
    const collection = resourceKind === 'agent' ? 'agents' : 'workspaces';
    return scopedRequest(`/v1/${collection}/${encodeURIComponent(resourceId)}/history`, { signal });
  },
  saveWorkspaceContext: (workspaceId, context, signal) => scopedRequest(`/v1/workspaces/${encodeURIComponent(workspaceId)}/context`, { method: 'PATCH', body: context, signal }),
};
