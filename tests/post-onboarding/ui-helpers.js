import { randomUUID } from 'node:crypto';
import { asOwner, browserClient } from './fixtures.js';

// Helpers shared by the owner screen tests. They talk to the same real handler and database the page uses.

/** A promise that the test settles by hand, for holding the text extractor while the page polls. */
export function deferred() {
  /** @type {(value?: any) => void} */ let resolve = () => {};
  /** @type {(reason?: any) => void} */ let reject = () => {};
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Runs `change(state)` on the owner's stored state as the database owner (backdating a test, seeding research). */
export async function changeState(harness, owner, change) {
  await asOwner(harness.pg, async () => {
    const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
    await change(state);
    await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
  });
}

let counter = 0;

/**
 * Publishes a knowledge change through the API as a second browser tab would, so the page under test is now on an old version.
 * @param {{app: any}} harness @param {{agentId: string, authToken: string}} owner @param {{group?: string, value: string}} fact
 */
export async function publishFactInOtherTab(harness, owner, { group = 'faq', value }) {
  const client = browserClient(harness.app, owner.authToken);
  const call = async (method, path, body) => {
    counter += 1;
    const response = await client.request(method, path, { body, headers: { 'idempotency-key': `other-tab-${counter}` } });
    return { status: response.status, body: await response.json() };
  };
  const view = (await call('GET', `/v1/agents/${owner.agentId}/knowledge`)).body;
  const created = await call('POST', `/v1/agents/${owner.agentId}/knowledge-updates`, { inputType: 'form', op: 'add', group, value, baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration });
  const { update } = created.body;
  const applied = await call('POST', `/v1/agents/${owner.agentId}/knowledge-updates/${update.updateId}/apply`, { expectedVersion: update.version, decisions: update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' })) });
  if (applied.status !== 202) throw new Error(`the other tab could not publish: ${applied.status}`);
}

/** Records every request the page makes with its idempotency key. `dropResponseOnce` runs a matching request for real, then fails it as a lost connection. */
export function watchRequests({ dropResponseOnce = null } = {}) {
  const inner = globalThis.fetch;
  const seen = [];
  let dropped = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://frontline.test');
    const entry = { method: init.method ?? 'GET', path: url.pathname, key: init.headers?.['Idempotency-Key'] ?? null };
    seen.push(entry);
    const response = await inner(input, init);
    if (dropResponseOnce && !dropped && dropResponseOnce(entry)) { dropped = true; throw new TypeError('Failed to fetch'); }
    return response;
  };
  return { seen, stop: () => { globalThis.fetch = inner; } };
}

/**
 * Adds another receptionist to the owner's business, as the create flow will: a lineage of its own that shares the first
 * receptionist's current knowledge, a name, and a selection (`sourceIds`: a list, 'all' for the first receptionist's own, or a function that picks from them).
 * @param {{pg: any}} harness @param {any} owner @param {{name: string, sourceIds?: string[]|'all'|((own: string[]) => string[])}} options
 * @returns {Promise<string>} the new receptionist's stable id
 */
export async function addReceptionist(harness, owner, { name, sourceIds = 'all' }) {
  const id = randomUUID();
  await asOwner(harness.pg, async () => {
    const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
    const first = state.agentLineages?.[owner.agentId];
    if (!first) throw new Error('The first receptionist has no library yet. Add or change knowledge first.');
    const current = state.agents[first.currentAgentVersionId];
    state.agents[id] = { ...current, id, businessName: current.businessName };
    state.agentLineages[id] = {
      stableAgentId: id, name, pointerGeneration: 1, currentAgentVersionId: id,
      revisions: [{ agentVersionId: id, knowledgeRevisionId: current.knowledgeRevisionId, parentAgentVersionId: null, kind: 'initial', createdAt: new Date().toISOString(), createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }],
      sourceIds: sourceIds === 'all' ? [...(first.sourceIds ?? [])] : typeof sourceIds === 'function' ? sourceIds(first.sourceIds ?? []) : sourceIds,
    };
    await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
    await harness.pg.query("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('agent',$1,$2,$3)", [id, owner.scopeId, owner.tenant]);
  });
  return id;
}
