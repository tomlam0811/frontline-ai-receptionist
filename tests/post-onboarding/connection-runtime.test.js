import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startConnectedApi } from './connected-api.js';

// PO-C4 (PO-T5): what the worker's runtime route returns for owner test and shared guest calls, bound by lineage.
let ctx;
beforeEach(async () => { ctx = await startConnectedApi(); });
afterEach(() => ctx.restore());

const runtime = async (demo) => {
  const response = await ctx.workerCall(demo, 'runtime', {}, {}, 'GET');
  return { status: response.status, json: await response.json() };
};
const summary = async () => (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json();
async function publishCapabilityChange(workflows) {
  const view = await summary();
  const saved = await ctx.ownerClient.request('PATCH', `/v1/agents/${ctx.owner.agentId}/capabilities`, {
    body: { baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, workflows },
    headers: { 'idempotency-key': `key-${Math.random().toString(16).slice(2)}` },
  });
  expect(saved.status).toBe(200);
  return (await summary()).currentAgentVersionId;
}

describe('runtime for a claimed Blake', () => {
  it('serves an owner test call from the pinned version, with its purpose, closing policy and enabled workflows', async () => {
    const demo = await ctx.startOwnerTest();
    const { status, json } = await runtime(demo);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      demoId: demo.id, mode: 'owner_test', representedEntity: 'business', businessName: 'Riverside Dental', agentVersionId: ctx.owner.agentId,
      knowledgeRevisionId: demo.knowledgeRevisionId, callPurpose: 'owner_test', closingPolicy: 'test_summary', sessionState: 'waiting',
    });
    expect(json.enabledWorkflows).toEqual(expect.arrayContaining(['WF-01', 'WF-06']));
    expect(json.facts.map((fact) => fact.value)).toContain('Teeth cleaning');
    expect(json.profile).toBeTruthy();
    expect(json.capabilityManifest.workflowCapabilities.length).toBeGreaterThan(0);
  });

  it('serves a shared guest call with the guest closing policy', async () => {
    const { demo } = await ctx.startGuestCall();
    expect((await runtime(demo)).json).toMatchObject({ mode: 'shared_guest', callPurpose: 'shared_guest', closingPolicy: 'guest_feedback', businessName: 'Riverside Dental' });
  });

  it('keeps the version a call started with after a later publish, and a new call gets the new version', async () => {
    const first = await ctx.startOwnerTest();
    const before = (await runtime(first)).json;
    const newVersion = await publishCapabilityChange({ 'WF-05': false });
    expect(newVersion).not.toBe(ctx.owner.agentId);
    // The running call is unchanged: same agent version, same knowledge revision, same enabled set.
    const during = (await runtime(first)).json;
    expect(during).toMatchObject({ agentVersionId: ctx.owner.agentId, knowledgeRevisionId: first.knowledgeRevisionId });
    expect(during.enabledWorkflows).toEqual(before.enabledWorkflows);
    expect(during.enabledWorkflows).toContain('WF-05');
    // Ending it and starting another test pins the new version.
    await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/tests/${first.id}/end`);
    const second = await ctx.startOwnerTest(newVersion);
    const after = (await runtime(second)).json;
    expect(after.agentVersionId).toBe(newVersion);
    expect(after.knowledgeRevisionId).not.toBe(first.knowledgeRevisionId);
    expect(after.enabledWorkflows).not.toContain('WF-05');
    // The first demo record still resolves to its own version once it has ended.
    expect((await ctx.demoRecord(first.id)).agentVersionId).toBe(ctx.owner.agentId);
  });

  it('refuses a demo whose pinned version is not a revision of its stable agent', async () => {
    const demo = await ctx.startOwnerTest();
    await ctx.ownerSql("UPDATE scoped_workspace_states SET state = jsonb_set(state, $2::text[], to_jsonb($3::text)) WHERE owner_scope_id = $1", [ctx.owner.scopeId, ['demos', demo.id, 'knowledgeRevisionId'], 'not-the-pinned-revision']);
    const { status, json } = await runtime(demo);
    expect(status).toBe(409);
    expect(json.title).toBe('runtime_binding_mismatch');
  });
});
