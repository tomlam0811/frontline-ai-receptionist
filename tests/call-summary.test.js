import { Readable } from 'node:stream';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCallSummary } from '../server/api/call-summary.js';
import { createApiHandler } from '../server/api/service.js';
import { DevelopmentStore } from '../server/api/store.js';
import { validateContract } from '../contracts/v1/contract-validator.js';

const endedAt = '2026-09-24T12:00:00.000Z';
const demoId = randomUUID();
const demo = { id: demoId, mode: 'business_demo', state: 'ended', stateRevision: 3,
  terminalReason: 'soft_close_elapsed', reconnectAllowed: false, endedAt,
  setupDeadlineAt: endedAt, startedAt: endedAt, softCloseAt: endedAt, hardEndAt: endedAt,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
const turn = (text, sequence) => ({ callerTurnId: randomUUID(), text, sequence, finalized: true });

describe('bounded call summary', () => {
  it('describes thirteen caller turns and an unfinished request without inventing a save', () => {
    const turns = [turn('I need a driveway wash next week.', 1),
      ...Array.from({ length: 11 }, (_, index) => turn(`My request detail number ${index + 2} is here.`, index + 2)),
      turn('Yes, those details are correct.', 13)];
    const state = { callerTurns: { [demoId]: turns }, workflows: { [demoId]: { currentTask: {
      kind: 'service_request', goal: 'Collect a driveway wash request', status: 'stopped',
      fields: { serviceNeed: 'Driveway washing', propertyCity: 'Irvine', callerName: 'Sam', contactEmail: 'sam@example.com' },
      missingFields: ['propertyState'],
      evidenceTurns: [{ callerTurnId: turns[0].callerTurnId }],
    } } }, outcomes: {}, cases: {}, receipts: {}, lookups: {} };
    const summary = buildCallSummary(state, demo);
    expect(summary).toMatchObject({ callerTurnCount: 13, tasks: [{ kind: 'service_request', status: 'stopped',
      saved: false, noted: false, missingFields: ['propertyState'], fields: { serviceNeed: 'Driveway washing', propertyCity: 'Irvine' } }] });
    expect(summary.callerExcerpts).toHaveLength(3);
    expect(summary.callerExcerpts[0]).toBe('I need a driveway wash next week.');
    expect(summary.callerExcerpts).not.toContain('Yes, those details are correct.');
    validateContract('boundary.schema.json#/$defs/callSummary', summary);
  });

  it('keeps Q&A as caller excerpts and empty calls empty', () => {
    const state = { callerTurns: { [demoId]: [turn('What can Frontline do?', 1), turn('How does setup work?', 2)] } };
    const qa = buildCallSummary(state, { ...demo, mode: 'frontline_qa' });
    expect(qa).toMatchObject({ callerTurnCount: 2, callerExcerpts: ['What can Frontline do?', 'How does setup work?'], tasks: [] });
    expect(buildCallSummary({}, demo)).toMatchObject({ callerTurnCount: 0, callerExcerpts: [], tasks: [] });
  });

  it('requires a matching saved receipt and record; task status alone is insufficient', () => {
    const receiptId = randomUUID(); const recordId = randomUUID();
    const task = { kind: 'service_request', goal: 'Collect request', status: 'succeeded', fields: {}, missingFields: [], receipt: { receiptId } };
    const state = { workflows: { [demoId]: { currentTask: task } }, outcomes: { [demoId]: [{ receiptId, recordId }] }, receipts: { one: { receiptId, recordId, outcome: 'saved' } } };
    expect(buildCallSummary(state, demo).tasks[0].saved).toBe(true);
    state.receipts.one.outcome = 'failed';
    expect(buildCallSummary(state, demo).tasks[0].saved).toBe(false);
    task.status = 'failed';
    expect(buildCallSummary(state, demo).tasks[0]).toMatchObject({ status: 'failed', saved: false });
  });
});

describe('scoped result HTTP', () => {
  let directory;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it('returns the recap only with the owning workspace cookie', async () => {
    directory = await mkdtemp(join(tmpdir(), 'frontline-summary-'));
    const store = new DevelopmentStore(join(directory, 'state.json'));
    const workspaceId = randomUUID(); const token = randomBytes(32).toString('hex');
    await store.transaction((state) => {
      state.workspaces[workspaceId] = { id: workspaceId, state: 'anonymous', secretHash: createHash('sha256').update(token).digest('hex'), expiresAt: demo.expiresAt };
      state.demos[demoId] = { ...demo, workspaceId };
      state.callerTurns[demoId] = [turn('Can you wash my driveway?', 1)];
    });
    const handler = createApiHandler({ store, preparationQueue: { healthy: () => true, start: async () => {}, stop: () => {} }, voiceAdapter: { end: async () => {} } });
    async function getResult(cookie) {
      /** @type {any} */
      const request = Readable.from([]); request.method = 'GET'; request.headers = {
        host: 'localhost', origin: 'http://localhost', 'x-frontline-csrf': 'csrf',
        cookie: `fl_workspace=${cookie}; fl_csrf=csrf`,
      }; request.socket = { remoteAddress: '127.0.0.1' };
      let status; let body = '';
      const response = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end(chunk = '') { body += String(chunk); }, destroy() {} };
      await handler(request, response, new URL(`/v1/demos/${demoId}/result`, 'http://localhost'));
      return { status, body: JSON.parse(body) };
    }
    const own = await getResult(token);
    expect(own.status).toBe(200);
    expect(own.body.callSummary).toMatchObject({ demoId, callerTurnCount: 1, callerExcerpts: ['Can you wash my driveway?'] });
    const payload = { ...own.body }; delete payload.requestId; delete payload.version;
    validateContract('boundary.schema.json#/$defs/demoResultResponse', payload);
    const foreign = await getResult(randomBytes(32).toString('hex'));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body.callSummary).toBeUndefined();
  });

  it('turns a partially collected task into a Needs review note when the caller ends the live session', async () => {
    directory = await mkdtemp(join(tmpdir(), 'frontline-summary-end-'));
    const store = new DevelopmentStore(join(directory, 'state.json'));
    const workspaceId = randomUUID(); const token = randomBytes(32).toString('hex');
    await store.transaction((state) => {
      state.workspaces[workspaceId] = { id: workspaceId, state: 'anonymous', secretHash: createHash('sha256').update(token).digest('hex'), expiresAt: demo.expiresAt };
      state.demos[demoId] = { ...demo, workspaceId, state: 'active', stateRevision: 1, terminalReason: null, reconnectAllowed: true,
        callArchitectureVersion: 'bob-task-v1', knowledgeRevisionId: randomUUID(), agentVersionId: randomUUID() };
      const caller = turn('Please wash my driveway next week.', 1);
      state.callerTurns[demoId] = [caller];
      state.workflows[demoId] = { workflowInstanceId: randomUUID(), workflowId: 'WF-01', phase: 'interpreting', revision: 2,
        allowedToolIds: [], currentTask: { taskId: randomUUID(), kind: 'service_request', goal: 'Driveway wash request', status: 'running',
          fields: { serviceNeed: 'Driveway washing', propertyCity: 'Irvine', contactPhone: '(408) 555-2147' }, missingFields: ['callerName', 'propertyState'],
          evidenceTurns: [{ callerTurnId: caller.callerTurnId, sequence: 1, text: caller.text }], noteRecordId: null } };
    });
    const handler = createApiHandler({ store, preparationQueue: { healthy: () => true, start: async () => {}, stop: () => {} }, voiceAdapter: { end: async () => {} } });
    async function call(action, method = 'GET') {
      /** @type {any} */
      const request = Readable.from([]); request.method = method; request.headers = {
        host: 'localhost', origin: 'http://localhost', 'x-frontline-csrf': 'csrf',
        cookie: `fl_workspace=${token}; fl_csrf=csrf`,
      }; request.socket = { remoteAddress: '127.0.0.1' };
      let status; let body = '';
      const response = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end(chunk = '') { body += String(chunk); }, destroy() {} };
      await handler(request, response, new URL(`/v1/demos/${demoId}/${action}`, 'http://localhost'));
      return { status, body: JSON.parse(body) };
    }
    expect((await call('end', 'POST')).status).toBe(200);
    const result = await call('result');
    expect(result.body).toMatchObject({ state: 'ended', receipts: [],
      requests: [{ reviewStatus: 'needs_review', endedBecause: 'caller_ended', missingFields: ['callerName', 'phoneConfirmed', 'propertyState'],
        nextStep: 'Call (408) 555-2147 to ask where the job is.', fields: { serviceNeed: 'Driveway washing', propertyCity: 'Irvine' } }],
      callSummary: { callerTurnCount: 1, tasks: [{ status: 'stopped', saved: false, noted: true,
        fields: { serviceNeed: 'Driveway washing', propertyCity: 'Irvine' } }] } });
    const payload = { ...result.body }; delete payload.requestId; delete payload.version;
    validateContract('boundary.schema.json#/$defs/demoResultResponse', payload);
  });
});
