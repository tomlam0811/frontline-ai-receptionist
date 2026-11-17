import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateContract, validateRetrievalResult, validateTerminalSession } from '../contracts/v1/contract-validator.js';
import { createApiHandler } from '../server/api/service.js';
import { DevelopmentStore } from '../server/api/store.js';
import { forceTerminal } from '../server/api/workflows.js';

const queue = { healthy: () => true, start: async () => {}, stop: () => {} };
const classified = (workflowId = 'WF-01') => ({ status: 'classified', workflowId, dialogueAct: 'question', confidence: 0.99, escalationReason: null, model: 'jev-1.13.0' });

describe('API workflow service contracts', () => {
  let directory; let store; let handler; let ids; let voice; let endState; let workspaceToken;

  beforeEach(async () => {
    vi.useRealTimers();
    directory = await mkdtemp(join(tmpdir(), 'frontline-api-workflow-'));
    store = new DevelopmentStore(join(directory, 'state.json'));
    const now = Date.now();
    const workspaceId = randomUUID(); const preparationId = randomUUID(); const knowledgeRevisionId = randomUUID(); const agentVersionId = randomUUID(); const demoId = randomUUID(); const passageId = randomUUID(); const factId = randomUUID();
    workspaceToken = randomBytes(32).toString('hex');
    ids = { workspaceId, preparationId, knowledgeRevisionId, agentVersionId, demoId, passageId, factId };
    const expiresAt = new Date(now + 3_600_000).toISOString();
    const passage = { passageId, source: { sourceId: randomUUID(), url: 'https://example.com/services', retrievedAt: new Date(now).toISOString() }, text: 'Commercial pressure washing is available.', classifications: ['services'], classificationModel: 'jev-1.13.0' };
    const fact = { factId, group: 'services', value: { name: 'Commercial pressure washing' }, passageIds: [passageId], applicableServiceIds: [], applicableLocationIds: [], eligibility: 'eligible', eligibilityReason: 'Direct published service.', observedAt: new Date(now).toISOString(), confidenceEvidence: { score: 0.99, basis: 'direct_passage', explanation: 'Direct website passage.' } };
    await store.transaction((state) => {
      state.workspaces[workspaceId] = { id: workspaceId, state: 'anonymous', secretHash: createHash('sha256').update(workspaceToken).digest('hex'), expiresAt };
      state.preparations[preparationId] = { id: preparationId, workspaceId, revision: 1, profile: { businessName: 'Example Wash' }, agentVersionId, knowledgeRevisionId, expiresAt };
      state.knowledge[knowledgeRevisionId] = { id: knowledgeRevisionId, workspaceId, facts: [], groupedFacts: [fact, { ...fact, factId: randomUUID(), eligibility: 'unknown', eligibilityReason: 'Unresolved.' }], classifiedPassages: [passage], groupedProfile: null, expiresAt };
      state.agents[agentVersionId] = { id: agentVersionId, workspaceId, knowledgeRevisionId, capabilityManifest: {}, expiresAt };
      state.demos[demoId] = { id: demoId, workspaceId, preparationId, preparationRevision: 1, mode: 'business_demo', agentVersionId, knowledgeRevisionId, roomName: `frontline-demo-${demoId}`, generation: 1, state: 'active', stateRevision: 1, reconnectAllowed: true, terminalReason: null, createdAt: new Date(now).toISOString(), setupDeadlineAt: new Date(now + 20_000).toISOString(), startedAt: new Date(now).toISOString(), softCloseAt: new Date(now + 270_000).toISOString(), hardEndAt: new Date(now + 300_000).toISOString(), expiresAt };
    });
    voice = { end: vi.fn(async () => { endState = (await store.read()).demos[demoId].state; }) };
    vi.stubEnv('FRONTLINE_VOICE_SERVICE_TOKEN', 'v'.repeat(40));
    handler = createApiHandler({ store, preparationQueue: queue, voiceAdapter: voice, classifyTurn: async (text) => text.includes('human') ? { ...classified('WF-06'), dialogueAct: 'request_human', escalationReason: 'human_preference' } : text.includes('services') ? classified('WF-01') : text.includes('complaint') ? { ...classified('WF-05'), dialogueAct: 'other' } : text.includes('cancel') ? { ...classified('WF-04'), dialogueAct: 'other' } : { ...classified('WF-03'), dialogueAct: /^yes\b/i.test(text) ? 'affirm' : 'provide_fields' } });
  });

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const headers = () => ({ authorization: `Bearer ${'v'.repeat(40)}`, 'x-frontline-room': `frontline-demo-${ids.demoId}`, 'x-frontline-generation': '1', 'x-frontline-agent-version-id': ids.agentVersionId, 'content-type': 'application/json' });
  const browserHeaders = () => ({ host: 'localhost', origin: 'http://localhost', 'x-frontline-csrf': 'csrf', cookie: `fl_workspace=${workspaceToken}; fl_csrf=csrf`, 'content-type': 'application/json' });
  async function api(path, options = {}) {
    const body = options.body ?? '';
    /** @type {any} */
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    request.method = options.method ?? 'GET'; request.headers = { ...headers(), ...options.headers }; request.socket = { remoteAddress: '127.0.0.1' };
    let status; let responseBody = '';
    const response = {
      headersSent: false,
      writeHead(code) { status = code; this.headersSent = true; },
      end(chunk = '') { responseBody += String(chunk); },
      destroy() {},
    };
    await handler(request, response, new URL(path, 'http://localhost'));
    return { status, body: JSON.parse(responseBody) };
  }
  const payload = (body) => { const value = { ...body }; delete value.requestId; delete value.version; return value; };

  it('keeps the runtime bundle under the worker limit when facts carry whole pages', async () => {
    // portplastics.com on 2026-10-03: 13 facts and 30 services each carried a 12,000-character page, and the worker
    // refused the 256 KB bundle, so the call never started.
    const page = `${'Industrial plastics and custom fabrication. '.repeat(260)}Call +1-866-507-8105 today.`;
    await store.transaction((state) => {
      state.knowledge[ids.knowledgeRevisionId].facts = Array.from({ length: 20 }, (_, index) => ({ id: `f${index}`, predicate: 'service', value: index ? `Service ${index}` : '+1-866-507-8105', sourceUrl: 'https://example.com/', evidence: page, status: 'eligible_for_demo' }));
      state.preparations[ids.preparationId].profile = { businessName: 'Example Wash', services: Array.from({ length: 30 }, (_, index) => ({ name: `Service ${index}`, sourceUrl: 'https://example.com/', evidence: page })) };
    });
    const runtime = await api(`/v1/internal/demos/${ids.demoId}/runtime`);
    expect(runtime.status).toBe(200);
    expect(JSON.stringify(runtime.body).length).toBeLessThan(256_000);
    expect(runtime.body.facts[0].evidence).toContain('+1-866-507-8105');
    expect(runtime.body.facts[0].evidence.length).toBeLessThanOrEqual(1_000);
    expect(runtime.body.profile.services).toHaveLength(30);
  });

  it('reports missing website research settings without exposing values or starting research', async () => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('FRONTLINE_EXA_DAILY_MAX_PREPARATIONS', '');
    expect(handler.researchReadiness()).toEqual({ ready: false, queueReady: true, workerReady: false, configurationReady: false, storageMode: 'development' });
    const unavailable = await api('/v1/preparations', {
      method: 'POST', headers: browserHeaders(), body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(unavailable).toMatchObject({ status: 503, body: { title: 'research_unavailable', detail: 'The request could not be completed.' } });
  });

  it('accepts Frontline Vercel project previews and rejects other Vercel origins', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', 'https://frontline-staging.preview.frontline.example');
    vi.stubEnv('FRONTLINE_ALLOWED_ORIGINS', 'https://frontline-njfwguofj.preview.frontline.example');
    const preparationQueue = { healthy: () => true, start: async () => {}, stop: async () => {}, enqueue: async () => 'admitted' };
    const productionStorageAdapter = { read: () => store.read(), transaction: (...args) => store.transaction(...args) };
    handler = createApiHandler({ store: productionStorageAdapter, preparationQueue, prepareBusiness: async () => ({}) });
    const request = (origin) => api('/v1/preparations', {
      method: 'POST',
      headers: { ...browserHeaders(), host: 'api.staging.frontline.example', origin },
      body: JSON.stringify({ url: 'https://example.com' }),
    });

    expect(await request('https://frontline-njfwguofj.preview.frontline.example')).toMatchObject({ status: 202 });
    expect(await request('https://other-project.vercel.app')).toMatchObject({ status: 403, body: { title: 'origin_mismatch' } });
    expect(await request('https://frontline-anotherid.preview.frontline.example')).toMatchObject({ status: 403, body: { title: 'origin_mismatch' } });
  });

  it('carries the business type onboarding labelled, so the call can ask what that trade asks', async () => {
    expect((await api(`/v1/internal/demos/${ids.demoId}/runtime`)).body).not.toHaveProperty('businessType');
    await store.transaction((state) => {
      state.preparations[ids.preparationId].businessFit = { verdict: 'fit', businessType: 'plumbing contractor', reason: 'Fixes leaks.' };
    });
    expect((await api(`/v1/internal/demos/${ids.demoId}/runtime`)).body.businessType).toBe('plumbing contractor');
  });

  it('returns runtime revisions and replays an exact turn before stale CAS checks', async () => {
    const runtime = await api(`/v1/internal/demos/${ids.demoId}/runtime`, { method: 'GET' });
    expect(runtime.status).toBe(200); expect(runtime.body).toMatchObject({ workflowRevision: 1, stateRevision: 1, sessionState: 'active', currentValidation: null, currentReadback: null });
    const input = { clientTurnId: randomUUID(), text: 'What services do you offer?', finalized: true, expectedWorkflowRevision: 1 };
    const first = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify(input) });
    expect(first.status).toBe(200); validateContract('boundary.schema.json#/$defs/turnDecision', payload(first.body));
    const replay = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify(input) });
    expect(payload(replay.body)).toEqual(payload(first.body));
    const stale = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ ...input, clientTurnId: randomUUID() }) });
    expect(stale.status).toBe(409); expect(stale.body).toMatchObject({ title: 'stale_workflow', currentWorkflowRevision: 2, currentStateRevision: 1 });
  });

  it('serves bob-task-v1 over authenticated HTTP without invoking Jev', async () => {
    await store.transaction((state) => { state.demos[ids.demoId].callArchitectureVersion = 'bob-task-v1'; });
    const runtime = await api(`/v1/internal/demos/${ids.demoId}/runtime`);
    expect(runtime.body).toMatchObject({ callArchitectureVersion: 'bob-task-v1', currentTask: null, workflowRevision: 1 });
    const first = await api(`/v1/internal/demos/${ids.demoId}/caller-turns`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'Please clean my driveway.', finalized: true }) });
    expect(first.status).toBe(201);
    validateContract('boundary.schema.json#/$defs/finalizedCallerTurn', payload(first.body));
    const taskId = randomUUID();
    const start = await api(`/v1/internal/demos/${ids.demoId}/task`, { method: 'POST', body: JSON.stringify({ action: 'start', taskId,
      kind: 'service_request', callerTurnId: first.body.callerTurnId, expectedWorkflowRevision: 1, goal: 'Collect a driveway cleaning request.' }) });
    expect(start.status).toBe(200);
    validateContract('task.schema.json#/$defs/response', payload(start.body));
    const normalizedReplay = await api(`/v1/internal/demos/${ids.demoId}/task`, { method: 'POST', body: JSON.stringify({ action: 'start', taskId,
      kind: 'service_request', callerTurnId: first.body.callerTurnId, expectedWorkflowRevision: 1, goal: '  Collect a driveway cleaning request.  ' }) });
    expect(payload(normalizedReplay.body)).toEqual(payload(start.body));
    const denied = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'Legacy route', finalized: true, expectedWorkflowRevision: 1 }) });
    expect(denied).toMatchObject({ status: 409, body: { title: 'unsupported_call_architecture' } });
    const recordInput = { action: 'record', taskId, operationId: randomUUID(), callerTurnId: first.body.callerTurnId,
      fields: { callerName: 'Sam', serviceNeed: 'Driveway cleaning', contactPhone: 'call me' } };
    const partial = await api(`/v1/internal/demos/${ids.demoId}/task`, { method: 'POST', body: JSON.stringify(recordInput) });
    expect(partial).toMatchObject({ status: 200, body: { task: { status: 'running' }, accepted: { callerName: 'Sam' }, rejected: { contactPhone: "That isn't a complete US phone number." } } });
    validateContract('task.schema.json#/$defs/response', payload(partial.body));
    const replay = await api(`/v1/internal/demos/${ids.demoId}/task`, { method: 'POST', body: JSON.stringify(recordInput) });
    expect(payload(replay.body)).toEqual(payload(partial.body));
    const changed = await api(`/v1/internal/demos/${ids.demoId}/task`, { method: 'POST', body: JSON.stringify({ ...recordInput, fields: { callerName: 'Pat' } }) });
    expect(changed).toMatchObject({ status: 409, body: { title: 'operation_conflict' } });
    const readback = await api(`/v1/internal/demos/${ids.demoId}/requests/readback`, { method: 'POST', body: JSON.stringify({ expectedWorkflowRevision: 1, fieldRevision: 1, payloadHash: 'a'.repeat(64) }) });
    expect(readback).toMatchObject({ status: 409, body: { title: 'unsupported_call_architecture' } });
    const complete = await api(`/v1/internal/demos/${ids.demoId}/task`, { method: 'POST', body: JSON.stringify({ action: 'record', taskId, operationId: randomUUID(),
      callerTurnId: first.body.callerTurnId, fields: { contactPhone: '408 555 2147', phoneConfirmed: true, propertyCity: 'Irvine', propertyState: 'CA' } }) });
    expect(complete).toMatchObject({ status: 200, body: { task: { status: 'succeeded', receipt: { outcome: 'saved' } } } });
    const runtimeAfter = await api(`/v1/internal/demos/${ids.demoId}/runtime`);
    expect(runtimeAfter.body).toMatchObject({ currentValidation: null, currentReadback: null, currentTask: { status: 'succeeded' } });
    validateContract('task.schema.json#/$defs/task', runtimeAfter.body.currentTask);
    expect((await store.read()).outcomes[ids.demoId]).toHaveLength(1);
  });

  it('turns an open task into a Needs review note when the caller ends the call, and the result shows its next step', async () => {
    await store.transaction((state) => { state.demos[ids.demoId].callArchitectureVersion = 'bob-task-v1'; });
    const endpoint = `/v1/internal/demos/${ids.demoId}`;
    const post = (path, body) => api(`${endpoint}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    const first = await post('caller-turns', { clientTurnId: randomUUID(), text: 'This is Sam, 408-555-2147, please wash my driveway.', finalized: true });
    const taskId = randomUUID();
    await post('task', { action: 'start', taskId, kind: 'service_request', callerTurnId: first.body.callerTurnId, goal: 'Driveway washing request' });
    await post('task', { action: 'record', taskId, operationId: randomUUID(), callerTurnId: first.body.callerTurnId,
      fields: { callerName: 'Sam', contactPhone: '408-555-2147', serviceNeed: 'Driveway washing' } });
    const ended = await post('ending', { expectedStateRevision: 1, reason: 'caller_ended' });
    expect(ended.status).toBe(200);
    await post('terminal', { expectedStateRevision: ended.body.stateRevision, reason: 'caller_ended' });
    const state = await store.read();
    expect(state.outcomes[ids.demoId]).toHaveLength(1);
    expect(state.outcomes[ids.demoId][0]).toMatchObject({ endedBecause: 'caller_ended', reviewStatus: 'needs_review', missingFields: ['phoneConfirmed', 'propertyCity'] });
    expect(state.workflows[ids.demoId].currentTask).toMatchObject({ status: 'stopped', noteRecordId: state.outcomes[ids.demoId][0].recordId });
  });

  it('returns contract-valid eligible evidence for list, exact service details, and fact retrieval', async () => {
    for (const [path, body] of [
      [`/v1/internal/demos/${ids.demoId}/services`, {}],
      [`/v1/internal/demos/${ids.demoId}/services/details`, { serviceId: ids.factId }],
      [`/v1/internal/demos/${ids.demoId}/lookup-business-fact`, { query: 'Do you offer commercial pressure washing?' }],
    ]) {
      const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      const result = payload(response.body); validateRetrievalResult(result);
      expect(result).toMatchObject({ knowledgeRevisionId: ids.knowledgeRevisionId, status: 'supported' });
      expect(result.facts).toHaveLength(1); expect(result.passages).toHaveLength(1);
    }
  });

  it('surfaces an owner-attested correction to a live call (PO-C5: Blake must use what the owner saved)', async () => {
    const ownerFactId = randomUUID();
    await store.transaction((state) => {
      state.knowledge[ids.knowledgeRevisionId].ownerFacts = [{
        id: ownerFactId, group: 'office_hours', category: 'hours', value: 'We are closed on Sundays.', scope: '',
        sourceId: randomUUID(), sourceType: 'owner_text', sourceUrl: null, evidence: 'We are closed on Sundays.',
        attestation: 'owner', status: 'eligible_for_demo', addedAt: new Date().toISOString(),
      }];
    });
    const response = await api(`/v1/internal/demos/${ids.demoId}/lookup-business-fact`, { method: 'POST', body: JSON.stringify({ query: 'Are you open on Sundays?' }) });
    expect(response.status).toBe(200);
    const result = payload(response.body); validateRetrievalResult(result);
    expect(result.status).toBe('supported');
    expect(result.facts).toContainEqual(expect.objectContaining({ factId: ownerFactId, value: 'We are closed on Sundays.' }));
    const passage = result.passages.find((item) => item.text === 'We are closed on Sundays.');
    expect(passage).toMatchObject({ classificationModel: 'owner-attested-v1', source: { sourceType: 'owner_text', label: 'Typed by you' } });
  });

  it('puts the fact that best matches a lookup first, so an owner answer is not cut off behind website facts', async () => {
    const ownerFactId = randomUUID();
    const process = 'Our process for commercial pressure washing: the owner follows up on the address and pricing, a worker checks the area, then we wash it and send photos.';
    await store.transaction((state) => {
      state.knowledge[ids.knowledgeRevisionId].ownerFacts = [{
        id: ownerFactId, group: 'faq', category: 'faq', value: process, scope: '', sourceId: randomUUID(), sourceType: 'owner_text',
        sourceUrl: null, evidence: process, attestation: 'owner', status: 'eligible_for_demo', addedAt: new Date().toISOString(),
      }];
    });
    const response = await api(`/v1/internal/demos/${ids.demoId}/lookup-business-fact`, { method: 'POST', body: JSON.stringify({ query: 'process for commercial pressure washing' }) });
    const result = payload(response.body); validateRetrievalResult(result);
    expect(result.facts.length).toBeGreaterThan(1);
    expect(result.facts[0].factId).toBe(ownerFactId);
    expect(result.passages[0].text).toBe(process);
  });

  it('drives collect through readback, affirmative confirmation, and one saved receipt', async () => {
    const first = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'Take my request details', finalized: true, expectedWorkflowRevision: 1 }) });
    expect(first.body.nextAction).toBe('collect');
    const fields = { callerName: 'Sam', contactEmail: 'sam@example.com', serviceNeed: 'pressure washing', propertyCity: 'Long Beach' };
    const validation = await api(`/v1/internal/demos/${ids.demoId}/requests/validate`, { method: 'POST', body: JSON.stringify({ expectedWorkflowRevision: first.body.workflow.revision, callerTurnId: first.body.callerTurn.callerTurnId, fields }) });
    validateContract('boundary.schema.json#/$defs/fieldValidation', payload(validation.body));
    const recovery = await api(`/v1/internal/demos/${ids.demoId}/runtime`, { method: 'GET' });
    expect(recovery.body.currentValidation).toMatchObject({ fieldRevision: validation.body.fieldRevision, payloadHash: validation.body.payloadHash });
    const readback = await api(`/v1/internal/demos/${ids.demoId}/requests/readback`, { method: 'POST', body: JSON.stringify({ expectedWorkflowRevision: validation.body.workflowRevision, fieldRevision: validation.body.fieldRevision, payloadHash: validation.body.payloadHash }) });
    validateContract('boundary.schema.json#/$defs/readback', payload(readback.body));
    const affirm = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'Yes, that is correct', finalized: true, expectedWorkflowRevision: readback.body.workflowRevision }) });
    expect(affirm.body.nextAction).toBe('confirm');
    const confirmation = await api(`/v1/internal/demos/${ids.demoId}/requests/confirmations`, { method: 'POST', body: JSON.stringify({ expectedWorkflowRevision: affirm.body.workflow.revision, callerTurnId: affirm.body.callerTurn.callerTurnId, fieldRevision: readback.body.fieldRevision, readbackRevision: readback.body.readbackRevision, payloadHash: readback.body.payloadHash }) });
    validateContract('confirmation.schema.json', payload(confirmation.body));
    const operationId = randomUUID();
    const saved = await api(`/v1/internal/demos/${ids.demoId}/requests`, { method: 'POST', body: JSON.stringify({ operationId, expectedWorkflowRevision: confirmation.body.workflowRevision, confirmationId: confirmation.body.confirmationId }) });
    expect(saved.status).toBe(201); expect(payload(saved.body)).toMatchObject({ operationId, operationKind: 'request', outcome: 'saved' });
    expect((await store.read()).outcomes[ids.demoId]).toHaveLength(1);
  });

  it('rejects adversarial cross-workflow endpoints and replays a prior receipt before authority checks', async () => {
    const question = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'What services are available?', finalized: true, expectedWorkflowRevision: 1 }) });
    const revision = question.body.workflow.revision;
    const callerTurnId = question.body.callerTurn.callerTurnId;
    for (const [path, body] of [
      ['requests/validate', { expectedWorkflowRevision: revision, callerTurnId, fields: { callerName: 'Sam' } }],
      ['appointments/lookup', { operationId: randomUUID(), expectedWorkflowRevision: revision, callerName: 'Sam', action: 'cancel' }],
      ['cases', { operationId: randomUUID(), expectedWorkflowRevision: revision, kind: 'complaint', context: { summary: 'Unauthorized complaint', callerTurnIds: [callerTurnId] } }],
    ]) {
      const denied = await api(`/v1/internal/demos/${ids.demoId}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      expect(denied).toMatchObject({ status: 409, body: { title: 'workflow_tool_not_allowed', currentWorkflowRevision: revision } });
    }

    const complaint = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'I have a complaint', finalized: true, expectedWorkflowRevision: revision }) });
    const saveInput = { operationId: randomUUID(), expectedWorkflowRevision: complaint.body.workflow.revision, kind: 'complaint', context: { summary: 'Poor service', callerTurnIds: [complaint.body.callerTurn.callerTurnId] } };
    const saved = await api(`/v1/internal/demos/${ids.demoId}/cases`, { method: 'POST', body: JSON.stringify(saveInput) });
    const moved = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'What services are available?', finalized: true, expectedWorkflowRevision: saved.body.workflowRevision }) });
    expect(moved.body.workflow.workflowId).toBe('WF-01');
    const replay = await api(`/v1/internal/demos/${ids.demoId}/cases`, { method: 'POST', body: JSON.stringify(saveInput) });
    expect(payload(replay.body)).toEqual(payload(saved.body));
  });

  it('keeps Frontline Q&A product-only and rejects every business write path', async () => {
    await store.transaction((state) => {
      state.demos[ids.demoId].mode = 'frontline_qa';
      state.demos[ids.demoId].agentVersionId = null;
      state.demos[ids.demoId].knowledgeRevisionId = 'frontline-product-v1';
    });
    const fallbackHeader = { 'x-frontline-agent-version-id': 'frontline-qa-v1' };
    const turn = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', headers: fallbackHeader, body: JSON.stringify({ clientTurnId: randomUUID(), text: 'Take my request details', finalized: true, expectedWorkflowRevision: 1 }) });
    expect(turn.body).toMatchObject({ nextAction: 'answer', workflow: { workflowId: 'WF-01', allowedToolIds: [] }, classification: { workflowId: 'WF-01' } });
    const product = await api(`/v1/internal/demos/${ids.demoId}/lookup-frontline-fact`, { method: 'POST', headers: fallbackHeader, body: JSON.stringify({ query: 'What can the demo do?' }) });
    expect(product.status).toBe(200); expect(product.body.facts.length).toBeGreaterThan(0);
    for (const [path, body] of [
      ['requests/validate', {}], ['requests', {}], ['appointments/lookup', {}], ['cases', {}], ['escalations', {}], ['services', {}], ['lookup-business-fact', {}],
    ]) {
      const denied = await api(`/v1/internal/demos/${ids.demoId}/${path}`, { method: 'POST', headers: fallbackHeader, body: JSON.stringify(body) });
      expect(denied).toMatchObject({ status: 403, body: { title: 'wrong_mode' } });
    }
  });

  it('commits terminal metadata before bounded provider cleanup and permits exact terminal replay', async () => {
    const ending = await api(`/v1/internal/demos/${ids.demoId}/ending`, { method: 'POST', body: JSON.stringify({ expectedStateRevision: 1, reason: 'completed' }) });
    expect(ending.status).toBe(200);
    const terminal = await api(`/v1/internal/demos/${ids.demoId}/terminal`, { method: 'POST', body: JSON.stringify({ expectedStateRevision: ending.body.stateRevision, reason: 'completed' }) });
    expect(terminal.status).toBe(200); validateTerminalSession(payload(terminal.body)); expect(endState).toBe('ended');
    const stored = (await store.read()).demos[ids.demoId];
    expect(stored).toMatchObject({ state: 'ended', terminalReason: 'completed', reconnectAllowed: false, stateRevision: 3 });
    const replay = await api(`/v1/internal/demos/${ids.demoId}/terminal`, { method: 'POST', body: JSON.stringify({ expectedStateRevision: 2, reason: 'completed' }) });
    expect(payload(replay.body)).toEqual(payload(terminal.body));
  });

  it('does not let browser end preempt an authoritative escalation receipt or closing speech', async () => {
    const turn = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'I want a human', finalized: true, expectedWorkflowRevision: 1 }) });
    expect(turn.body).toMatchObject({ nextAction: 'escalate', classification: { escalationReason: 'human_preference' }, workflow: { phase: 'ending' } });

    const browserEnd = await api(`/v1/demos/${ids.demoId}/end`, { method: 'POST', headers: browserHeaders() });
    expect(browserEnd.body).toMatchObject({ state: 'ending', terminalReason: 'human_preference', reconnectAllowed: false });
    expect(voice.end).not.toHaveBeenCalled();

    const operationId = randomUUID();
    const input = { operationId, expectedWorkflowRevision: turn.body.workflow.revision, reason: 'human_preference', context: { summary: 'Caller asked for a human', callerTurnIds: [turn.body.callerTurn.callerTurnId] } };
    const saved = await api(`/v1/internal/demos/${ids.demoId}/escalations`, { method: 'POST', body: JSON.stringify(input) });
    expect(saved).toMatchObject({ status: 201, body: { operationId, operationKind: 'escalation', outcome: 'saved' } });
    const replay = await api(`/v1/internal/demos/${ids.demoId}/escalations`, { method: 'POST', body: JSON.stringify(input) });
    expect(payload(replay.body)).toEqual(payload(saved.body));

    const terminal = await api(`/v1/internal/demos/${ids.demoId}/terminal`, { method: 'POST', body: JSON.stringify({ expectedStateRevision: turn.body.workflow.revision, reason: 'human_preference' }) });
    expect(terminal.status).toBe(200);
    expect(voice.end).toHaveBeenCalledTimes(1);
    const state = await store.read();
    expect(state.cases[ids.demoId]).toHaveLength(1);
    expect(Object.values(state.receipts).filter((receipt) => receipt.operationKind === 'escalation')).toHaveLength(1);
  });

  it('bounds a failed escalation save through worker terminal without inventing a receipt', async () => {
    const turn = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'I want a human', finalized: true, expectedWorkflowRevision: 1 }) });
    await api(`/v1/demos/${ids.demoId}/end`, { method: 'POST', headers: browserHeaders() });
    const failed = await api(`/v1/internal/demos/${ids.demoId}/escalations`, { method: 'POST', body: JSON.stringify({ operationId: randomUUID(), expectedWorkflowRevision: turn.body.workflow.revision, reason: 'human_preference', context: { summary: 'Invalid stale context', callerTurnIds: [randomUUID()] } }) });
    expect(failed).toMatchObject({ status: 409, body: { title: 'stale_caller_turn' } });
    const terminal = await api(`/v1/internal/demos/${ids.demoId}/terminal`, { method: 'POST', body: JSON.stringify({ expectedStateRevision: 2, reason: 'human_preference' }) });
    expect(terminal.status).toBe(200);
    expect(Object.keys((await store.read()).receipts)).toHaveLength(0);
  });

  it('keeps the browser out of an ending escalation until the authoritative deadline forces closure', async () => {
    await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'I want a human', finalized: true, expectedWorkflowRevision: 1 }) });
    const browser = await api(`/v1/demos/${ids.demoId}/end`, { method: 'POST', headers: browserHeaders() });
    expect(browser.body.state).toBe('ending');
    const forced = await store.transaction((state) => forceTerminal(state, state.demos[ids.demoId], 'hard_end_elapsed'));
    expect(forced).toMatchObject({ status: 'terminal', reason: 'hard_end_elapsed' });
    expect((await store.read()).demos[ids.demoId]).toMatchObject({ state: 'ended', terminalReason: 'hard_end_elapsed' });
  });

  it('serializes a delayed escalation save ahead of worker terminal after browser end', async () => {
    const turn = await api(`/v1/internal/demos/${ids.demoId}/turn`, { method: 'POST', body: JSON.stringify({ clientTurnId: randomUUID(), text: 'I want a human', finalized: true, expectedWorkflowRevision: 1 }) });
    await api(`/v1/demos/${ids.demoId}/end`, { method: 'POST', headers: browserHeaders() });
    const originalTransaction = store.transaction.bind(store); let delay = true;
    let enteredTransaction;
    const entered = new Promise((resolve) => { enteredTransaction = resolve; });
    store.transaction = (callback) => originalTransaction(async (state) => {
      if (delay) { delay = false; enteredTransaction(); await new Promise((resolve) => setTimeout(resolve, 40)); }
      return callback(state);
    });
    const input = { operationId: randomUUID(), expectedWorkflowRevision: turn.body.workflow.revision, reason: 'human_preference', context: { summary: 'Delayed persistence', callerTurnIds: [turn.body.callerTurn.callerTurnId] } };
    const saving = api(`/v1/internal/demos/${ids.demoId}/escalations`, { method: 'POST', body: JSON.stringify(input) });
    await entered;
    const terminal = api(`/v1/internal/demos/${ids.demoId}/terminal`, { method: 'POST', body: JSON.stringify({ expectedStateRevision: 2, reason: 'human_preference' }) });
    expect((await saving).status).toBe(201); expect((await terminal).status).toBe(200);
    expect((await store.read()).cases[ids.demoId]).toHaveLength(1);
  });
});
