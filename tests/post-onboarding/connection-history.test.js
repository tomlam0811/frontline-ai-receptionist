import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthClaims } from '../../server/api/auth-claims.js';
import { startConnectedApi } from './connected-api.js';
import { browserClient, seedClaimedOwner } from './fixtures.js';
import { callerSays } from './ui-calls.js';

// PO-C7 (PO-T11): the existing history route lists conversations from every version of the same Blake.
let ctx;
beforeEach(async () => {
  // The existing history route needs the identity provider to be configured; the database and sessions are real.
  ctx = await startConnectedApi({ apiOptions: (store) => ({ authClaims: createAuthClaims({ pool: store.pool, googleIdentity: /** @type {any} */ ({ isConfigured: () => true }) }) }) });
});
afterEach(() => ctx.restore());

const history = async (client = ctx.ownerClient, agentId = ctx.owner.agentId) => {
  const response = await client.request('GET', `/v1/agents/${agentId}/history`);
  return { status: response.status, json: await response.json() };
};
async function finishedCall(versionId) {
  const demo = await ctx.startOwnerTest(versionId);
  await ctx.workerCall(demo, 'ready');
  await callerSays(ctx.pg, ctx.owner.scopeId, demo.id, 'What are your opening hours?');
  expect((await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/tests/${demo.id}/end`)).status).toBe(200);
  return demo;
}
async function publishNewVersion() {
  const view = await (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json();
  const saved = await ctx.ownerClient.request('PATCH', `/v1/agents/${ctx.owner.agentId}/capabilities`, {
    body: { baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, workflows: { 'WF-05': false } },
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(saved.status).toBe(200);
  return (await (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json()).currentAgentVersionId;
}

describe('history across versions', () => {
  it('lists the conversations of every version of the same Blake', async () => {
    const first = await finishedCall(ctx.owner.agentId);
    const newVersion = await publishNewVersion();
    const second = await finishedCall(newVersion);
    expect(second.agentVersionId).toBe(newVersion);
    const { status, json } = await history();
    expect(status).toBe(200);
    expect(json.callSummaries.map((item) => item.demoId).sort()).toEqual([first.id, second.id].sort());
  });

  it('includes a shared guest conversation of the same Blake', async () => {
    const { demo, cookie } = await ctx.startGuestCall();
    await ctx.workerCall(demo, 'ready');
    await callerSays(ctx.pg, ctx.owner.scopeId, demo.id, 'Do you work weekends?');
    expect((await ctx.guestPost('/v1/shared/end', cookie)).status).toBe(200);
    expect((await history()).json.callSummaries.map((item) => item.demoId)).toEqual([demo.id]);
  });

  it('shows nothing of this Blake to another signed-in owner', async () => {
    await finishedCall(ctx.owner.agentId);
    const other = await seedClaimedOwner(ctx.pg, { researched: true });
    await ctx.pg.exec('SET ROLE frontline_app');
    const otherClient = browserClient(ctx.app, other.authToken);
    expect((await history(otherClient, ctx.owner.agentId)).status).toBe(404);
    expect((await history(otherClient, other.agentId)).json.callSummaries).toEqual([]);
  });
});
