import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disabledWorkflowIds } from '../../server/api/workflows.js';
import { startConnectedApi } from './connected-api.js';
import { callerSays, scopeState } from './ui-calls.js';

// PO-C6 (PO-T9): a version that turned a workflow off refuses its tools, at task start and at every tool endpoint.
// Real API handler, real store code and migrations; the classifier is the only stand-in (it is a paid model).
let ctx; let classification; let savedArchitecture;
const classify = async () => classification;
const CLASSIFIED = (workflowId) => ({ status: 'classified', workflowId, dialogueAct: 'other', confidence: 0.95, escalationReason: null, model: 'jev-1.13.0' });

beforeEach(async () => {
  savedArchitecture = process.env.FRONTLINE_CALL_ARCHITECTURE;
  classification = CLASSIFIED('WF-05');
  ctx = await startConnectedApi({ apiOptions: { classifyTurn: classify } });
});
afterEach(() => {
  if (savedArchitecture === undefined) delete process.env.FRONTLINE_CALL_ARCHITECTURE; else process.env.FRONTLINE_CALL_ARCHITECTURE = savedArchitecture;
  ctx.restore();
});

const summary = async () => (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json();
async function turnOffWorkflows(workflows) {
  const view = await summary();
  const saved = await ctx.ownerClient.request('PATCH', `/v1/agents/${ctx.owner.agentId}/capabilities`, {
    body: { baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, workflows },
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(saved.status).toBe(200);
  return (await summary()).currentAgentVersionId;
}
/** Ends the running call and starts the next test call on the newest version, ready and active. */
async function nextCall(previous, versionId) {
  if (previous) await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/tests/${previous.id}/end`);
  const demo = await ctx.startOwnerTest(versionId);
  expect((await ctx.workerCall(demo, 'ready')).status).toBe(200);
  return demo;
}
const post = async (demo, action, body = {}) => { const response = await ctx.workerCall(demo, action, body); return { status: response.status, json: await response.json() }; };
const TOOL_ROUTES = [['requests/validate', 'WF-03'], ['requests/readback', 'WF-03'], ['requests/confirmations', 'WF-03'], ['requests', 'WF-03'], ['appointments/lookup', 'WF-04'], ['cases', 'WF-05']];

describe('legacy call architecture', () => {
  it('leaves every tool endpoint available to a version with the default capabilities', async () => {
    const demo = await nextCall(null);
    for (const [route] of TOOL_ROUTES) {
      const { json } = await post(demo, route);
      expect(json.title, route).not.toBe('workflow_disabled');
    }
  });

  it('refuses the tools of a workflow the pinned version turned off, and only those', async () => {
    const first = await nextCall(null);
    const version = await turnOffWorkflows({ 'WF-03': false, 'WF-04': false, 'WF-05': false });
    const demo = await nextCall(first, version);
    for (const [route] of TOOL_ROUTES) {
      const { status, json } = await post(demo, route);
      expect(status, route).toBe(409);
      expect(json.title, route).toBe('workflow_disabled');
    }
    // Escalation is a WF-06 tool and stays available.
    expect((await post(demo, 'escalations')).json.title).not.toBe('workflow_disabled');
    // The earlier call still runs on its own version.
    expect((await ctx.demoRecord(first.id)).agentVersionId).toBe(ctx.owner.agentId);
  });

  it('answers a request for a disabled workflow with WF-01, and keeps routing when it is on', async () => {
    const turn = (demo, text) => post(demo, 'turn', { clientTurnId: randomUUID(), text, finalized: true, expectedWorkflowRevision: 1 });
    const first = await nextCall(null);
    const enabled = await turn(first, 'I want to make a complaint about my last visit.');
    expect(enabled.json.workflow.workflowId).toBe('WF-05');
    const version = await turnOffWorkflows({ 'WF-05': false });
    const demo = await nextCall(first, version);
    const disabled = await turn(demo, 'I want to make a complaint about my last visit.');
    expect(disabled.status).toBe(200);
    expect(disabled.json.workflow).toMatchObject({ workflowId: 'WF-01', allowedToolIds: ['retrieve_facts', 'get_service_details'] });
    expect(disabled.json.nextAction).toBe('answer');
  });
});

describe('task call architecture', () => {
  const startTask = async (demo, kind) => {
    await callerSays(ctx.pg, ctx.owner.scopeId, demo.id, 'I need someone to look at my gutters.');
    const turnId = (await scopeState(ctx.pg, ctx.owner.scopeId)).callerTurns[demo.id].at(-1).callerTurnId;
    const workflowRevision = (await scopeState(ctx.pg, ctx.owner.scopeId)).workflows?.[demo.id]?.revision ?? 1;
    return post(demo, 'task', { action: 'start', taskId: randomUUID(), kind, callerTurnId: turnId, expectedWorkflowRevision: workflowRevision, goal: 'Take a service request.' });
  };

  it('starts tasks for owner test calls, and refuses a task of a turned-off workflow with 409', async () => {
    process.env.FRONTLINE_CALL_ARCHITECTURE = 'bob-task-v1';
    const first = await nextCall(null);
    const started = await startTask(first, 'service_request');
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(started.json.task).toMatchObject({ kind: 'service_request', status: 'running', agentVersionId: ctx.owner.agentId });
    const version = await turnOffWorkflows({ 'WF-03': false });
    const demo = await nextCall(first, version);
    const refused = await startTask(demo, 'service_request');
    expect(refused.status).toBe(409);
    expect(refused.json.title).toBe('workflow_disabled');
    // Another task kind on the same version still starts.
    expect((await startTask(demo, 'complaint')).status).toBe(200);
  });
});

describe('workflows that can never be disabled', () => {
  it('ignores a capability list that turns off answering or escalation', () => {
    const state = { agents: { v1: { capabilityManifest: { workflowCapabilities: [
      { workflowId: 'WF-01', enabled: false }, { workflowId: 'WF-06', enabled: false }, { workflowId: 'WF-03', enabled: false }, { workflowId: 'WF-04', enabled: true },
    ] } } } };
    expect([...disabledWorkflowIds(state, { agentVersionId: 'v1' })]).toEqual(['WF-03']);
    expect(disabledWorkflowIds({ agents: {} }, { agentVersionId: 'frontline-qa-v1' }).size).toBe(0);
    expect(disabledWorkflowIds({ agents: { v1: { capabilityManifest: {} } } }, { agentVersionId: 'v1' }).size).toBe(0);
  });

  it('is refused when an owner tries to save a capability list without them', async () => {
    const view = await summary();
    for (const workflow of ['WF-01', 'WF-06']) {
      const response = await ctx.ownerClient.request('PATCH', `/v1/agents/${ctx.owner.agentId}/capabilities`, {
        body: { baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, workflows: { [workflow]: false } },
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect((await summary()).currentAgentVersionId).toBe(view.currentAgentVersionId);
  });
});
