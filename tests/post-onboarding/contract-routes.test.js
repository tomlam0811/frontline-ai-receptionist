import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateContract } from '../../contracts/v1/contract-validator.js';
import { fromPglite, inOwnerScope } from '../../server/api/post-onboarding/database.js';
import { readDemo, updateDemo } from '../../server/api/post-onboarding/demo-store.js';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { markShareActive, markShareConsumed } from '../../server/api/post-onboarding/share.js';
import { createMigratedDatabase } from './database.js';
import { browserClient, fakeVoice, seedClaimedOwner, seedSession, startServer } from './fixtures.js';

// PO-C17: every route marked planned_post_onboarding in contracts/v1/http-endpoints.json is driven against the
// real handler and real (in-process) Postgres. The request I send and the response I get must both satisfy the
// schema the contract names. Only the paid providers (LiveKit, the extraction model) are faked.
const SCHEMA = 'schemas/post-onboarding.schema.json';
const endpointFile = JSON.parse(await readFile('contracts/v1/http-endpoints.json', 'utf8'));
const planned = endpointFile.endpoints.filter((endpoint) => endpoint.status === 'planned_post_onboarding');
const exercised = new Set();

let pg; let db; let app; let voice; let workerScope; let owner; let builder; let ownerClient; let builderClient; let version; let generation;
const key = () => ({ 'idempotency-key': randomUUID() });
const refName = (ref) => ref.$ref.replace(/^schemas\//, '');
const stripEnvelope = (body) => { const { requestId, version: apiVersion, ...payload } = body; validateContract('boundary.schema.json#/$defs/responseMetadata', { requestId, version: apiVersion }); return payload; };

/**
 * Sends one request for a contract route, validates the body I sent and the body that came back, and records the route as covered.
 * @param {string} method @param {string} template the path as written in the contract @param {{path?: string, body?: any, query?: any, client?: any, headers?: any, status?: number, raw?: (() => Promise<Response>)}} options
 */
async function exchange(method, template, { path = template, body, client = ownerClient, headers = {}, status = 200, raw } = {}) {
  const endpoint = planned.find((item) => item.method === method && item.path === template);
  expect(endpoint, `${method} ${template} is in the contract`).toBeTruthy();
  if (body !== undefined) validateContract(refName(endpoint.request), body);
  const response = raw ? await raw() : await client.request(method, path, { body, headers });
  const text = await response.text();
  expect(response.status, `${method} ${path}: ${text.slice(0, 300)}`).toBe(status);
  const json = JSON.parse(text);
  validateContract(refName(endpoint.response), stripEnvelope(json));
  exercised.add(`${method} ${template}`);
  return { json, response };
}

/** What the real terminal path does for a finished call (connection PO-C1 supplies the real one). */
async function endCall({ scopeId, demoId }) {
  const demo = await readDemo(db, scopeId, demoId);
  await inOwnerScope(db, scopeId, (tx) => tx.query("SELECT settle_voice_start($1::uuid,'completed')", [demo.reservationId]));
  const ended = await updateDemo(db, scopeId, demoId, () => ({ state: 'ended', endedAt: new Date().toISOString(), terminalReason: 'caller_ended', voiceCleanupCompleted: true }));
  if (demo.shareGrantId) { await markShareActive({ db, demo }); await markShareConsumed({ db, demo, reason: 'caller_ended' }); }
  return { demoId, state: ended.state };
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = fromPglite(pg);
  owner = await seedClaimedOwner(pg, { researched: true });
  builder = await seedSession(pg, { builder: true });
  await pg.exec('SET ROLE frontline_app');
  voice = fakeVoice();
  app = startServer(pg, {
    voice, limits: { ownerWrite: 10_000, ownerRead: 10_000, guest: 10_000 },
    guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 1_000_000, reservedCents: 100, globalConcurrent: 500 },
    endOwnerDemo: endCall, endGuestDemo: endCall, endLiveCall: endCall,
    worker: async (request) => (request.headers.authorization === 'Bearer worker-ok' && workerScope ? { scopeId: workerScope } : null),
    extraction: { available: { text: true }, extract: async () => ({ proposed: [] }) },
  });
  ownerClient = browserClient(app, owner.authToken);
  builderClient = browserClient(app, builder.authToken);
});
afterAll(async () => { await app?.close(); });

describe('post-onboarding contract routes, driven through the real handler', () => {
  const A = () => `/v1/agents/${owner.agentId}`;

  it('owner home, Blake summary and the first visit', async () => {
    const list = await exchange('GET', '/v1/me/agents');
    expect(list.json.agents).toHaveLength(1);
    const summary = await exchange('GET', '/v1/agents/{stableAgentId}/summary', { path: `${A()}/summary` });
    version = summary.json.currentAgentVersionId; generation = summary.json.pointerGeneration;
    await exchange('POST', '/v1/agents/{stableAgentId}/first-visit', { path: `${A()}/first-visit`, body: { outcome: 'skipped' } });
    const renamed = await exchange('PATCH', '/v1/agents/{stableAgentId}/name', { path: `${A()}/name`, body: { name: 'Sam' } });
    expect(renamed.json).toMatchObject({ stableAgentId: owner.agentId, name: 'Sam' });
    // Blake is free again, so a second receptionist takes the default name.
    const added = await exchange('POST', '/v1/me/agents', { body: {}, headers: key(), status: 201 });
    expect(added.json).toMatchObject({ name: 'Blake', versionNumber: 1, needsKnowledge: false });
    expect((await exchange('GET', '/v1/me/agents')).json.agents.map((agent) => agent.name)).toEqual(['Sam', 'Blake']);
  });

  it('knowledge: read, propose, poll, cancel, reopen and apply', async () => {
    const view = (await exchange('GET', '/v1/agents/{stableAgentId}/knowledge', { path: `${A()}/knowledge` })).json;
    const propose = (value) => exchange('POST', '/v1/agents/{stableAgentId}/knowledge-updates', { path: `${A()}/knowledge-updates`, status: 202, headers: key(), body: { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, op: 'add', group: 'services', value } });
    const dropped = (await propose('Bleaching')).json.update;
    await exchange('GET', '/v1/agents/{stableAgentId}/knowledge-updates/{updateId}', { path: `${A()}/knowledge-updates/${dropped.updateId}` });
    await exchange('POST', '/v1/agents/{stableAgentId}/knowledge-updates/{updateId}/cancel', { path: `${A()}/knowledge-updates/${dropped.updateId}/cancel`, body: { expectedVersion: dropped.version } });
    const update = (await propose('Whitening')).json.update;
    const late = (await propose('Braces')).json.update;
    const applied = await exchange('POST', '/v1/agents/{stableAgentId}/knowledge-updates/{updateId}/apply', {
      path: `${A()}/knowledge-updates/${update.updateId}/apply`, status: 202, headers: key(),
      body: { expectedVersion: update.version, decisions: update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' })) },
    });
    // A second change made on the same base is now stale: applying it is refused and leaves it in conflict, which the owner can reopen.
    const refused = await ownerClient.request('POST', `${A()}/knowledge-updates/${late.updateId}/apply`, { headers: key(), body: { expectedVersion: late.version, decisions: late.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' })) } });
    expect(refused.status).toBe(409);
    expect(validateContract(`${SCHEMA}#/$defs/problemResponse`, stripEnvelope(await refused.json()))).toMatchObject({ title: 'stale_agent_version', currentAgentVersionId: applied.json.update.appliedAgentVersionId });
    const reopened = await exchange('POST', '/v1/agents/{stableAgentId}/knowledge-updates/{updateId}/reopen', { path: `${A()}/knowledge-updates/${late.updateId}/reopen` });
    expect(reopened.json.update.state).toBe('review');
    version = applied.json.update.appliedAgentVersionId; generation += 1;
    // Choosing sources publishes a version too.
    const current = (await exchange('GET', '/v1/agents/{stableAgentId}/knowledge', { path: `${A()}/knowledge` })).json;
    // Both receptionists (the renamed one and the one added above) use the onboarding website. Only the first uses the source the owner just added.
    expect(current.sources.filter((source) => source.usedBy.length).map((source) => source.usedBy.length)).toEqual([2, 1]);
    const selected = await exchange('PUT', '/v1/agents/{stableAgentId}/knowledge-sources-selection', { path: `${A()}/knowledge-sources-selection`, body: { sourceIds: current.sourceIds, expectedAgentVersionId: version } });
    expect(selected.json).toMatchObject({ sourceIds: current.sourceIds, pointerGeneration: generation + 1 });
    version = selected.json.currentAgentVersionId; generation += 1;
  });

  it('capabilities, tests, conversations, feedback and version review', async () => {
    await exchange('GET', '/v1/agents/{stableAgentId}/capabilities', { path: `${A()}/capabilities` });
    const saved = await exchange('PATCH', '/v1/agents/{stableAgentId}/capabilities', { path: `${A()}/capabilities`, headers: key(), body: { baseAgentVersionId: version, expectedPointerGeneration: generation, workflows: { 'WF-05': false } } });
    version = saved.json.currentAgentVersionId; generation = saved.json.pointerGeneration;

    const started = await exchange('POST', '/v1/agents/{stableAgentId}/tests', { path: `${A()}/tests`, status: 201, body: { expectedAgentVersionId: version } });
    const demoId = started.json.demoId;
    // The owner spoke during the test, so the version counts as tested.
    await pg.exec('RESET ROLE');
    const state = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
    state.callerTurns = { [demoId]: [{ callerTurnId: randomUUID(), clientTurnId: randomUUID(), demoId, sequence: 1, text: 'Do you do whitening?', finalized: true, recordedAt: new Date().toISOString(), workflowRevision: 1 }] };
    await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
    await pg.exec('SET ROLE frontline_app');
    await exchange('GET', '/v1/agents/{stableAgentId}/tests/{demoId}/result', { path: `${A()}/tests/${demoId}/result` });
    await exchange('POST', '/v1/agents/{stableAgentId}/tests/{demoId}/end', { path: `${A()}/tests/${demoId}/end`, body: {} });
    await exchange('GET', '/v1/agents/{stableAgentId}/conversations', { path: `${A()}/conversations` });
    const one = await exchange('GET', '/v1/agents/{stableAgentId}/conversations/{conversationId}', { path: `${A()}/conversations/${demoId}` });
    expect(one.json.origin).toBe('owner_test');
    // A Needs review note on that call, marked done by the owner (VA-D13).
    const recordId = randomUUID();
    await pg.exec('RESET ROLE');
    const withNote = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
    withNote.outcomes = { ...withNote.outcomes, [demoId]: [{ recordId, demoId, workflowInstanceId: randomUUID(), knowledgeRevisionId: randomUUID(), profileRevisionId: randomUUID(), agentVersionId: version,
      kind: 'service_request', taskId: randomUUID(), goal: 'Driveway washing', fields: { callerName: 'Tom', contactPhone: '(408) 555-2147' }, confirmation: null, receiptId: null,
      savedAt: new Date().toISOString(), bookingState: 'not_booked', deliveryState: 'not_sent', reviewStatus: 'needs_review', reviewedAt: null, missingFields: ['serviceNeed', 'propertyCity'], endedBecause: 'caller_ended' }] };
    await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(withNote)]);
    await pg.exec('SET ROLE frontline_app');
    await exchange('GET', '/v1/agents/{stableAgentId}/conversations/{conversationId}', { path: `${A()}/conversations/${demoId}` });
    const reviewed = await exchange('POST', '/v1/agents/{stableAgentId}/conversations/{conversationId}/outcomes/{recordId}/review', { path: `${A()}/conversations/${demoId}/outcomes/${recordId}/review`, body: { reviewStatus: 'done' } });
    expect(reviewed.json.record).toMatchObject({ recordId, reviewStatus: 'done', nextStep: 'Call Tom at (408) 555-2147 to ask what they need and where the job is.' });
    await exchange('POST', '/v1/agents/{stableAgentId}/feedback', { path: `${A()}/feedback`, status: 201, headers: key(), body: { category: 'quality', inputMethod: 'text', text: 'Blake talked over me during the test.' } });
    await exchange('POST', '/v1/agents/{stableAgentId}/versions/{versionId}/review', { path: `${A()}/versions/${version}/review`, body: { expectedPointerGeneration: generation } });
  });

  it('share links and the guest conversation', async () => {
    const shareBody = { expectedAgentVersionId: version };
    const link = await exchange('POST', '/v1/agents/{stableAgentId}/shares', { path: `${A()}/shares`, status: 201, headers: key(), body: shareBody });
    await exchange('POST', '/v1/agents/{stableAgentId}/shares', { path: `${A()}/shares`, status: 201, headers: key(), body: shareBody });
    const listed = await exchange('GET', '/v1/agents/{stableAgentId}/shares', { path: `${A()}/shares` });
    const spare = listed.json.shares.find((share) => share.shareId !== link.json.shareId);
    await exchange('DELETE', '/v1/agents/{stableAgentId}/shares/{shareId}', { path: `${A()}/shares/${spare.shareId}?expectedVersion=${spare.version}` });

    const guestCall = (method, path, cookie, body) => () => app.fetch(`${app.baseUrl}${path}`, { method, headers: { origin: app.baseUrl, ...(cookie ? { cookie } : {}), ...(body === undefined ? { 'x-frontline-guest': '1' } : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const token = new URL(link.json.url).hash.replace('#t=', '');
    const exchanged = await exchange('POST', '/v1/shared/exchange', { body: { token }, raw: guestCall('POST', '/v1/shared/exchange', null, { token }) });
    const cookie = exchanged.response.headers.get('set-cookie').split(';')[0];
    await exchange('GET', '/v1/shared/session', { raw: guestCall('GET', '/v1/shared/session', cookie) });
    const guestStart = await exchange('POST', '/v1/shared/start', { status: 201, body: {}, raw: guestCall('POST', '/v1/shared/start', cookie, {}) });
    expect(guestStart.json.participantToken).toBeTruthy();
    await exchange('POST', '/v1/shared/reconnect', { body: {}, raw: guestCall('POST', '/v1/shared/reconnect', cookie, {}) });
    await exchange('GET', '/v1/shared/session', { raw: guestCall('GET', '/v1/shared/session', cookie) });
    await exchange('POST', '/v1/shared/end', { body: {}, raw: guestCall('POST', '/v1/shared/end', cookie, {}) });
    await exchange('GET', '/v1/shared/result', { raw: guestCall('GET', '/v1/shared/result', cookie) });
    await exchange('POST', '/v1/shared/feedback', { status: 201, body: { category: 'quality', inputMethod: 'text', text: 'It was clear.' }, raw: guestCall('POST', '/v1/shared/feedback', cookie, { category: 'quality', inputMethod: 'text', text: 'It was clear.' }) });
  });

  it('builder feedback, status and the CLI credential', async () => {
    const search = await exchange('GET', '/v1/builder/feedback', { path: '/v1/builder/feedback?q=talked', client: builderClient });
    expect(search.json.records.length).toBeGreaterThan(0);
    const target = search.json.records[0];
    await exchange('GET', '/v1/builder/feedback/{feedbackId}', { path: `/v1/builder/feedback/${target.id}`, client: builderClient });
    await exchange('PATCH', '/v1/builder/feedback/{feedbackId}', { path: `/v1/builder/feedback/${target.id}`, client: builderClient, body: { status: 'reviewed', expectedRevision: target.revision } });
    await exchange('GET', '/v1/builder/session', { client: builderClient });

    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const issueCode = async (label) => (await exchange('POST', '/v1/builder/credentials', { client: builderClient, status: 201, body: { challenge, label } })).json.code;
    const exchangeBody = async (label) => ({ code: await issueCode(label), verifier });
    const first = await exchangeBody('laptop');
    const issued = await exchange('POST', '/v1/builder/credentials/exchange', { status: 201, body: first, raw: () => app.fetch(`${app.baseUrl}/v1/builder/credentials/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first) }) });
    await exchange('DELETE', '/v1/builder/credentials/current', { raw: () => app.fetch(`${app.baseUrl}/v1/builder/credentials/current`, { method: 'DELETE', headers: { authorization: `Bearer ${issued.json.token}` } }) });
    const second = await exchangeBody('ci');
    const another = await (await app.fetch(`${app.baseUrl}/v1/builder/credentials/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(second) })).json();
    await exchange('DELETE', '/v1/builder/credentials/{credentialId}', { path: `/v1/builder/credentials/${another.credentialId}`, client: builderClient });
  });

  it('the voice worker records what Blake said', async () => {
    workerScope = owner.scopeId;
    const started = await (await ownerClient.request('POST', `${A()}/tests`, { body: { expectedAgentVersionId: version } })).json();
    const body = { clientTurnId: randomUUID(), text: 'We are open until five.', interrupted: false, expectedStateRevision: 1 };
    await exchange('POST', '/v1/internal/demos/{demoId}/assistant-turns', { path: `/v1/internal/demos/${started.demoId}/assistant-turns`, status: 201, body, raw: () => app.fetch(`${app.baseUrl}/v1/internal/demos/${started.demoId}/assistant-turns`, { method: 'POST', headers: { authorization: 'Bearer worker-ok', 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  });

  it('problems have one shape, with the extra fields the contract names', async () => {
    const stale = await ownerClient.request('POST', `${A()}/tests`, { body: { expectedAgentVersionId: randomUUID() } });
    expect(stale.status).toBe(409);
    expect(validateContract(`${SCHEMA}#/$defs/problemResponse`, stripEnvelope(await stale.json()))).toMatchObject({ title: 'stale_agent_version' });
    const signedOut = await browserClient(app, null).request('GET', '/v1/me/agents');
    expect(signedOut.status).toBe(401);
    validateContract(`${SCHEMA}#/$defs/problemResponse`, stripEnvelope(await signedOut.json()));
    const unavailable = await app.fetch(`${app.baseUrl}/v1/shared/exchange`, { method: 'POST', headers: { origin: app.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'A'.repeat(43) }) });
    expect(validateContract(`${SCHEMA}#/$defs/problemResponse`, stripEnvelope(await unavailable.json()))).toMatchObject({ title: 'link_unavailable', reason: 'unavailable' });
  });

  it('source erasure: fence, cleanup and status', async () => {
    const view = (await exchange('GET', '/v1/agents/{stableAgentId}/knowledge', { path: `${A()}/knowledge` })).json;
    const source = view.sources.find((item) => item.type === 'owner_form');
    const path = `${A()}/knowledge-sources/${source.sourceId}/erase`;
    const refused = await ownerClient.request('POST', path, { body: { confirm: true, expectedPointerGeneration: view.pointerGeneration - 1 } });
    expect(refused.status).toBe(409);
    expect(validateContract(`${SCHEMA}#/$defs/problemResponse`, stripEnvelope(await refused.json()))).toMatchObject({ title: 'stale_agent_version', currentPointerGeneration: view.pointerGeneration });
    const started = await exchange('POST', '/v1/agents/{stableAgentId}/knowledge-sources/{sourceId}/erase', { path, status: 202, body: { confirm: true, expectedPointerGeneration: view.pointerGeneration } });
    expect(started.json).toMatchObject({ sourceId: source.sourceId, status: 'pending' });
    await app.idle();
    const polled = await exchange('GET', '/v1/agents/{stableAgentId}/knowledge-sources/{sourceId}/erase/{jobId}', { path: `${path}/${started.json.jobId}` });
    expect(['pending', 'completed'], JSON.stringify(polled.json)).toContain(polled.json.status);
    const after = (await exchange('GET', '/v1/agents/{stableAgentId}/knowledge', { path: `${A()}/knowledge` })).json;
    expect(after.sources.map((item) => item.sourceId)).not.toContain(source.sourceId);
    expect(after.sourceErasures.map((job) => job.jobId)).toEqual([started.json.jobId]);
  });

  it('pause and resume a receptionist', async () => {
    const paused = await exchange('POST', '/v1/agents/{stableAgentId}/pause', { path: `${A()}/pause`, body: {} });
    expect(paused.json).toMatchObject({ status: 'paused' });
    expect((await exchange('GET', '/v1/agents/{stableAgentId}/summary', { path: `${A()}/summary` })).json.status).toBe('paused');
    const resumed = await exchange('POST', '/v1/agents/{stableAgentId}/resume', { path: `${A()}/resume`, body: {} });
    expect(resumed.json).toMatchObject({ status: 'active' });
  });

  it('delete an account, as another owner so the routes above keep theirs', async () => {
    const leaving = await seedClaimedOwner(pg);
    const deleted = await exchange('DELETE', '/v1/me/account', { client: browserClient(app, leaving.authToken), status: 202 });
    expect(deleted.json).toMatchObject({ status: 'deleted' });
    expect(deleted.response.headers.get('set-cookie')).toMatch(/fl_auth=;/);
    await app.idle();
  });

  it('covers every planned route, and a response with a stray or missing field fails the schema', async () => {
    const summary = stripEnvelope(await (await ownerClient.request('GET', `${A()}/summary`)).json());
    const ref = `${SCHEMA}#/$defs/agentSummaryResponse`;
    expect(validateContract(ref, summary)).toBe(summary);
    expect(() => validateContract(ref, { ...summary, extra: 1 })).toThrow('unknown property');
    const { businessName, ...missing } = summary;
    expect(businessName).toBeDefined();
    expect(() => validateContract(ref, missing)).toThrow('businessName is required');
    expect(() => validateContract(`${SCHEMA}#/$defs/knowledgeUpdateInput`, { inputType: 'form', baseAgentVersionId: version, expectedPointerGeneration: 1, op: 'add', group: 'made_up' })).toThrow();
    // Deleting comes last: it is the one route that removes the receptionist the other routes ran against.
    const deleted = await exchange('DELETE', '/v1/agents/{stableAgentId}', { path: A(), status: 202 });
    expect(deleted.json).toMatchObject({ status: 'deleting' });
    expect([...exercised].sort()).toEqual(planned.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort());
  });
});
