import { randomUUID } from 'node:crypto';
import { browserClient } from './fixtures.js';

// Calls the owner API the way a second browser tab would, so a screen test can start from a business that already has
// several receptionists, or one that needs knowledge. Everything goes through the real handler and database.

/** @param {{app: any}} harness @param {{authToken: string}} owner */
const clientFor = (harness, owner) => browserClient(harness.app, owner.authToken);

/** Adds a receptionist through POST /v1/me/agents. Returns the new receptionist's summary. */
export async function addReceptionistByApi(harness, owner, name) {
  const response = await clientFor(harness, owner).request('POST', '/v1/me/agents', { body: { name }, headers: { 'idempotency-key': randomUUID() } });
  if (response.status !== 201) throw new Error(`could not add ${name}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Renames a receptionist through PATCH /v1/agents/:id/name. */
export async function renameByApi(harness, owner, agentId, name) {
  const response = await clientFor(harness, owner).request('PATCH', `/v1/agents/${agentId}/name`, { body: { name } });
  if (response.status !== 200) throw new Error(`could not rename to ${name}: ${response.status}`);
}

/** Deselects every source of a receptionist, so it needs knowledge. `summary` is its current summary. */
export async function clearKnowledgeByApi(harness, owner, summary) {
  const response = await clientFor(harness, owner).request('PUT', `/v1/agents/${summary.stableAgentId}/knowledge-sources-selection`, { body: { sourceIds: [], expectedAgentVersionId: summary.currentAgentVersionId } });
  if (response.status !== 200) throw new Error(`could not clear knowledge: ${response.status} ${await response.text()}`);
}

/** Pauses a receptionist through the API. */
export async function pauseByApi(harness, owner, agentId) {
  const response = await clientFor(harness, owner).request('POST', `/v1/agents/${agentId}/pause`, { body: {} });
  if (response.status !== 200) throw new Error(`could not pause: ${response.status}`);
}

/** Wraps window.fetch so requests matching `match` are answered with `problem` (an RFC 9457 body) instead of reaching the server. `times` limits how many. */
export function failRequests({ match, status = 500, title = 'internal_error', detail = 'Something went wrong.', times = Infinity }) {
  const inner = globalThis.fetch;
  let left = times;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://frontline.test');
    if (left > 0 && match({ method: init.method ?? 'GET', path: url.pathname })) {
      left -= 1;
      return new Response(JSON.stringify({ title, detail, status }), { status, headers: { 'content-type': 'application/problem+json' } });
    }
    return inner(input, init);
  };
  return { stop: () => { globalThis.fetch = inner; } };
}
