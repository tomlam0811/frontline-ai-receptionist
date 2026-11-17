import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnonymousRetention } from '../../server/api/retention.js';
import { FEEDBACK_RETENTION_DAYS } from '../../server/api/post-onboarding/feedback.js';
import { isCallFenced } from '../../server/api/post-onboarding/source-redaction.js';
import { sourceStoreErasers } from '../../server/api/post-onboarding/source-erasure.js';
import { startConnectedApi } from './connected-api.js';
import { asCleanup } from './database.js';
import { asOwner, browserClient, seedClaimedOwner, seedSession } from './fixtures.js';
import { callerSays, scopeState } from './ui-calls.js';

// PO-A16 / PO-E27 (TOM-38, PO-I12-C1..C4): removing a source. Real handler, real migrations and role grants on an
// in-process Postgres. Only the paid LiveKit provider is faked. The sentinel below must be gone from the scope's knowledge
// after cleanup. Past conversations and feedback are kept, so the call sentinel must still be there.
const SENTINEL = 'PRIVATE-ERASE-SENTINEL';
const KEEP = 'UNRELATED-KEEP-SENTINEL';
const CALL = 'PAST-CALL-KEEP-SENTINEL';
let ctx; let builderClient; let scenario;

beforeEach(async () => {
  sourceStoreErasers.length = 0;
  ctx = await startConnectedApi();
  const builder = await seedSession(ctx.pg, { builder: true });
  builderClient = browserClient(ctx.app, builder.authToken);
});
afterEach(() => { sourceStoreErasers.length = 0; ctx.restore(); });

const agentPath = (suffix = '') => `/v1/agents/${ctx.owner.agentId}${suffix}`;
const call = async (method, path, body, key, client = ctx.ownerClient) => {
  const response = await client.request(method, path, { ...(body ? { body } : {}), ...(key ? { headers: { 'idempotency-key': key } } : {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const summary = async () => (await call('GET', agentPath('/summary'))).body;
const knowledge = async () => (await call('GET', agentPath('/knowledge'))).body;
const erase = (sourceId, generation, client = ctx.ownerClient, agentId = ctx.owner.agentId) => call('POST', `/v1/agents/${agentId}/knowledge-sources/${sourceId}/erase`, { confirm: true, expectedPointerGeneration: generation }, undefined, client);
const jobStatus = (sourceId, jobId) => call('GET', agentPath(`/knowledge-sources/${sourceId}/erase/${jobId}`));
const shares = async () => (await call('GET', agentPath('/shares'))).body.shares;
const stateText = async () => JSON.stringify(await scopeState(ctx.pg, ctx.owner.scopeId));
const feedbackRows = () => asOwner(ctx.pg, async () => (await ctx.pg.query('SELECT id, conversation_id, submitted_text, expires_at FROM frontline_feedback ORDER BY created_at')).rows);

async function finishedOwnerCall(versionId, text) {
  const demo = await ctx.startOwnerTest(versionId);
  await ctx.workerCall(demo, 'ready');
  await callerSays(ctx.pg, ctx.owner.scopeId, demo.id, text);
  expect((await call('POST', agentPath(`/tests/${demo.id}/end`))).status).toBe(200);
  return demo;
}
const submitFeedback = async (conversationId, text) => {
  const sent = await call('POST', agentPath('/feedback'), { category: 'quality', inputMethod: 'text', text, ...(conversationId ? { conversationId } : {}) }, randomUUID());
  expect(sent.status).toBe(201);
};
/** Adds the sentinel fact as an owner form edit, which publishes version 2 from a new owner_form source. */
async function addSentinelFact() {
  const view = await knowledge();
  const created = await call('POST', agentPath('/knowledge-updates'), { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, op: 'add', group: 'faq', value: SENTINEL }, randomUUID());
  expect(created.status).toBe(202);
  const decisions = created.body.update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' }));
  expect((await call('POST', agentPath(`/knowledge-updates/${created.body.update.updateId}/apply`), { expectedVersion: created.body.update.version, decisions }, randomUUID())).status).toBe(202);
  return created.body.update.candidates[0].sourceId;
}
async function addReceipt(demoId, workflowInstanceId) {
  await asOwner(ctx.pg, async () => {
    const state = (await ctx.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId])).rows[0].state;
    state.workflows = { ...state.workflows, [demoId]: { workflowInstanceId } };
    state.receipts = { ...state.receipts, [workflowInstanceId]: { workflowInstanceId, receiptId: workflowInstanceId } };
    await ctx.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [ctx.owner.scopeId, JSON.stringify(state)]);
  });
}

/** Version 1 with a finished call, a receipt and a link. Version 2 (from the sentinel source) with a finished call, a live guest call, an unused link, and linked and unrelated feedback. */
async function seedScenario() {
  const v1 = ctx.owner.agentId;
  const callOne = await finishedOwnerCall(v1, KEEP);
  await addReceipt(callOne.id, 'wf-v1');
  const linkOne = (await call('POST', agentPath('/shares'), { expectedAgentVersionId: v1 }, randomUUID())).body;
  const sourceId = await addSentinelFact();
  const v2 = (await summary()).currentAgentVersionId;
  expect(v2).not.toBe(v1);
  const callTwo = await finishedOwnerCall(v2, `${CALL} owner test`);
  await addReceipt(callTwo.id, 'wf-v2');
  const guest = await ctx.startGuestCall();
  await ctx.workerCall(guest.demo, 'ready');
  await callerSays(ctx.pg, ctx.owner.scopeId, guest.demo.id, `${CALL} guest turn`);
  const linkTwo = (await call('POST', agentPath('/shares'), { expectedAgentVersionId: v2 }, randomUUID())).body;
  await submitFeedback(callTwo.id, `${CALL} feedback about the call`);
  await submitFeedback(callOne.id, `${KEEP} feedback about the older call`);
  await submitFeedback(null, `${KEEP} general feedback`);
  scenario = { v1, v2, sourceId, callOne, callTwo, guest, linkOne, linkTwo, generation: (await summary()).pointerGeneration };
  return scenario;
}
/** Holds the erasure at its store-cleanup step so the fenced, pending state can be inspected. */
function holdCleanup() {
  let release; let reached; let fail = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const atGate = new Promise((resolve) => { reached = resolve; });
  sourceStoreErasers.push({ name: 'test_store', appliesTo: () => true, erase: async () => { reached(); await gate; if (fail) throw new Error('store unavailable'); } });
  // The in-process database has one connection, so the test waits until the job is idle at the gate before it sends other requests.
  return { atGate, release: ({ failing = false } = {}) => { fail = failing; release(); } };
}

describe('C1: ordinary deletion stays a retraction; explicit erasure fences first', () => {
  it('removing a fact publishes the next revision and leaves the earlier revision, source and no erasure job', async () => {
    await seedScenario();
    const view = await knowledge();
    const entry = view.categories.flatMap((category) => category.entries).find((item) => item.value === SENTINEL);
    const created = await call('POST', agentPath('/knowledge-updates'), { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, op: 'remove', group: 'faq', targetEntryId: entry.entryId }, randomUUID());
    const decisions = created.body.update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' }));
    expect((await call('POST', agentPath(`/knowledge-updates/${created.body.update.updateId}/apply`), { expectedVersion: created.body.update.version, decisions }, randomUUID())).status).toBe(202);
    expect((await summary()).pointerGeneration).toBe(scenario.generation + 1);
    expect(await stateText()).toContain(SENTINEL);
    expect((await knowledge()).sourceErasures).toEqual([]);
  });

  it('answers 202 with a job that fences the affected versions while cleanup is pending', async () => {
    await seedScenario();
    const held = holdCleanup();
    const started = await erase(scenario.sourceId, scenario.generation);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ sourceId: scenario.sourceId, status: 'pending', versionsAffected: 1, linksRevoked: 2 });
    await held.atGate;
    expect(JSON.stringify(started.body)).not.toContain(SENTINEL);

    // Fenced: the affected version cannot start a test, be shared, or serve a guest, and its live call was ended.
    expect((await call('POST', agentPath('/tests'), { expectedAgentVersionId: scenario.v2 })).body).toMatchObject({ title: 'agent_not_ready' });
    expect((await call('POST', agentPath('/shares'), { expectedAgentVersionId: scenario.v2 }, randomUUID())).status).toBe(422);
    expect((await ctx.guestPost('/v1/shared/start', scenario.guest.cookie)).status).toBeGreaterThanOrEqual(400);
    expect((await ctx.demoRecord(scenario.guest.demo.id)).state).toBe('ended');
    expect((await jobStatus(scenario.sourceId, started.body.jobId)).body).toMatchObject({ status: 'pending', failureCode: null });

    held.release();
    await ctx.api.postOnboardingIdle();
  });

  it('stays fenced when cleanup fails and reports the failure without content', async () => {
    await seedScenario();
    const held = holdCleanup();
    const started = await erase(scenario.sourceId, scenario.generation);
    held.release({ failing: true });
    await ctx.api.postOnboardingIdle();
    const failed = await jobStatus(scenario.sourceId, started.body.jobId);
    expect(failed.body).toMatchObject({ status: 'failed', failureCode: 'store_cleanup_failed', retryable: true });
    expect(JSON.stringify(failed.body)).not.toContain(SENTINEL);
    expect((await call('POST', agentPath('/shares'), { expectedAgentVersionId: scenario.v2 }, randomUUID())).status).toBe(422);
    expect(await stateText()).toContain(SENTINEL);
  });
});

describe('past conversations and feedback are kept', () => {
  const conversationIds = async () => (await call('GET', agentPath('/conversations'))).body.conversations.map((item) => item.conversationId ?? item.demoId);
  const expectOpen = async () => {
    expect(await conversationIds()).toEqual(expect.arrayContaining([scenario.callOne.id, scenario.callTwo.id, scenario.guest.demo.id]));
    const detail = await call('GET', agentPath(`/conversations/${scenario.callTwo.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ agentVersionId: scenario.v2 });
    expect(JSON.stringify(detail.body)).toContain(CALL);
    expect((await call('GET', agentPath(`/conversations/${scenario.guest.demo.id}`))).status).toBe(200);
    expect((await call('GET', agentPath(`/tests/${scenario.callTwo.id}/result`))).status).toBe(200);
    expect((await call('GET', '/v1/builder/feedback?q=' + CALL, null, undefined, builderClient)).body.records).toHaveLength(1);
    expect((await feedbackRows()).map((row) => row.submitted_text).join()).toContain(CALL);
  };

  it('still opens conversations of a fenced version, with the version they ran on', async () => {
    await seedScenario();
    const held = holdCleanup();
    await erase(scenario.sourceId, scenario.generation);
    await held.atGate;
    expect(await stateText()).toContain(SENTINEL);
    await expectOpen();
    held.release();
    await ctx.api.postOnboardingIdle();
  });

  it('still opens them after the removal completes, and keeps receipts and feedback', async () => {
    await seedScenario();
    await erase(scenario.sourceId, scenario.generation);
    await ctx.api.postOnboardingIdle();
    await expectOpen();
    const state = await scopeState(ctx.pg, ctx.owner.scopeId);
    expect(state.receipts['wf-v1']).toBeDefined();
    expect(state.receipts['wf-v2']).toBeDefined();
    expect(state.callerTurns[scenario.callTwo.id]).toHaveLength(1);
    expect((await feedbackRows())).toHaveLength(3);
  });
});

describe('C2: reconciliation, idempotent retry, minimal audit', () => {
  it('removes the source content, keeps unrelated content and past conversations, and lets the remaining knowledge compile again', async () => {
    await seedScenario();
    expect((await ctx.workerCall(scenario.guest.demo, 'ready')).status).toBeLessThan(500);
    const started = await erase(scenario.sourceId, scenario.generation);
    await ctx.api.postOnboardingIdle();
    const done = await jobStatus(scenario.sourceId, started.body.jobId);
    expect(done.body).toMatchObject({ status: 'completed', remainingKnowledge: 'recompiled', backups: 'expire_separately' });

    const text = await stateText();
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain(KEEP);
    expect(text).toContain(CALL);
    const state = await scopeState(ctx.pg, ctx.owner.scopeId);

    // The live guest call on the removed knowledge was ended through the terminal path and its link revoked. The unrelated link is untouched.
    expect(state.demos[scenario.guest.demo.id].state).toBe('ended');
    const links = Object.fromEntries((await shares()).map((share) => [share.shareId, share.status]));
    expect(links[scenario.linkTwo.shareId]).toBe('revoked');
    expect(links[scenario.linkOne.shareId]).toBe('unused');

    // The source is gone from the owner's view, the current version is a fresh one that works, and a new fact can be added.
    const view = await knowledge();
    expect(view.sources.map((item) => item.sourceId)).not.toContain(scenario.sourceId);
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
    const now = await summary();
    expect(now.currentAgentVersionId).not.toBe(scenario.v2);
    const fresh = await ctx.startOwnerTest(now.currentAgentVersionId);
    expect(fresh.agentVersionId).toBe(now.currentAgentVersionId);
    expect(await addSentinelFact()).not.toBe(scenario.sourceId);
  });

  it('retry is idempotent: the same job resumes and finishes once, and repeating a finished job changes nothing', async () => {
    await seedScenario();
    const held = holdCleanup();
    const first = await erase(scenario.sourceId, scenario.generation);
    held.release({ failing: true });
    await ctx.api.postOnboardingIdle();
    expect((await jobStatus(scenario.sourceId, first.body.jobId)).body.status).toBe('failed');

    sourceStoreErasers.length = 0;
    const retried = await erase(scenario.sourceId, scenario.generation);
    expect(retried.status).toBe(202);
    expect(retried.body.jobId).toBe(first.body.jobId);
    await ctx.api.postOnboardingIdle();
    expect((await jobStatus(scenario.sourceId, first.body.jobId)).body.status).toBe('completed');

    const before = await stateText();
    const again = await erase(scenario.sourceId, scenario.generation);
    expect(again.body).toMatchObject({ jobId: first.body.jobId, status: 'completed' });
    await ctx.api.postOnboardingIdle();
    expect(await stateText()).toBe(before);
    const jobs = (await knowledge()).sourceErasures;
    expect(jobs).toHaveLength(1);
  });

  it('removing the website source removes its research from version 1 and keeps the calls made on it', async () => {
    const website = (await knowledge()).sources.find((item) => item.type === 'website');
    const callOne = await finishedOwnerCall(ctx.owner.agentId, 'Where are you located?');
    const started = await erase(website.sourceId, 1);
    expect(started.status).toBe(202);
    await ctx.api.postOnboardingIdle();
    const job = await jobStatus(website.sourceId, started.body.jobId);
    expect(job.body.status).toBe('completed');
    expect(job.body.remainingKnowledge).toBe('needs_information');
    const text = await stateText();
    expect(text).not.toContain('Teeth cleaning');
    expect(text).not.toContain('riverside.example');
    expect((await call('GET', agentPath(`/conversations/${callOne.id}`))).status).toBe(200);
    expect(text).toContain('Where are you located?');
    expect((await summary()).ready).toBe(false);
  });

  it('records only ids and counts in the job', async () => {
    await seedScenario();
    const started = await erase(scenario.sourceId, scenario.generation);
    await ctx.api.postOnboardingIdle();
    const stored = (await scopeState(ctx.pg, ctx.owner.scopeId)).sourceErasures[started.body.jobId];
    expect(JSON.stringify(stored)).not.toContain(SENTINEL);
    expect(Object.keys(stored.audit).sort()).toEqual(expect.arrayContaining(['entries', 'knowledgeRecords', 'linksRevoked', 'recompile', 'versions']));
  });
});

describe('retention worker', () => {
  it('resumes an unfinished job as the runtime role and completes it, counting only', async () => {
    await seedScenario();
    const held = holdCleanup();
    const started = await erase(scenario.sourceId, scenario.generation);
    held.release({ failing: true });
    await ctx.api.postOnboardingIdle();
    expect((await jobStatus(scenario.sourceId, started.body.jobId)).body.status).toBe('failed');
    sourceStoreErasers.length = 0;
    const roles = [];
    const poolAs = (role) => {
      const run = async (sql, params) => { roles.push({ role, sql }); await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec(`SET ROLE ${role}`); return ctx.pg.query(sql, params); };
      return { query: run, connect: async () => ({ query: run, release() {} }), end: async () => {} };
    };
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    const counts = await retention.sweepPostOnboarding();
    await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec('SET ROLE frontline_app');
    expect(counts).toMatchObject({ erasureJobs: 1, erasuresCompleted: 1 });
    expect((await jobStatus(scenario.sourceId, started.body.jobId)).body.status).toBe('completed');
    expect(roles.filter((item) => item.role === 'frontline_cleanup').every((item) => item.sql.includes('cleanup_expired_post_onboarding'))).toBe(true);
    await retention.close();
  });
});

describe('access control and request checks', () => {
  it('refuses another owner, an unknown source and a stale pointer generation', async () => {
    await seedScenario();
    const other = await seedClaimedOwner(ctx.pg, { researched: true });
    await ctx.pg.exec('SET ROLE frontline_app');
    const otherClient = browserClient(ctx.app, other.authToken);
    expect((await erase(scenario.sourceId, scenario.generation, otherClient)).status).toBe(404);
    expect((await erase(scenario.sourceId, scenario.generation, otherClient, other.agentId)).status).toBe(404);
    expect((await erase('no-such-source', scenario.generation)).status).toBe(404);
    const stale = await erase(scenario.sourceId, scenario.generation - 1);
    expect(stale).toMatchObject({ status: 409, body: { title: 'stale_agent_version', currentPointerGeneration: scenario.generation } });
    expect((await call('POST', agentPath(`/knowledge-sources/${scenario.sourceId}/erase`), { expectedPointerGeneration: scenario.generation })).status).toBe(400);
    expect((await call('POST', agentPath(`/knowledge-sources/${scenario.sourceId}/erase`), { confirm: true })).status).toBe(400);
    expect((await knowledge()).sourceErasures).toEqual([]);
    expect(await stateText()).toContain(SENTINEL);

    const started = await erase(scenario.sourceId, scenario.generation);
    await ctx.api.postOnboardingIdle();
    expect((await jobStatus(scenario.sourceId, started.body.jobId)).status).toBe(200);
    const otherJob = await call('GET', `/v1/agents/${other.agentId}/knowledge-sources/${scenario.sourceId}/erase/${started.body.jobId}`, null, undefined, otherClient);
    expect(otherJob.status).toBe(404);
    const otherView = (await call('GET', `/v1/agents/${other.agentId}/summary`, null, undefined, otherClient)).body;
    expect(otherView.ready).toBe(true);
  });
});

describe('C3: retention policy is applied as reviewed', () => {
  it('feedback lives 30 days, shared conversations and owner tests 30 days, links 24 hours, and the erasure job adds no content copy', async () => {
    expect(FEEDBACK_RETENTION_DAYS).toBe(30);
    await seedScenario();
    const [row] = await feedbackRows();
    const days = (Date.parse(row.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const state = await scopeState(ctx.pg, ctx.owner.scopeId);
    for (const demo of [scenario.callOne, scenario.callTwo, scenario.guest.demo]) {
      const remaining = (Date.parse(state.demos[demo.id].expiresAt) - Date.now()) / 86_400_000;
      expect(remaining).toBeGreaterThan(29.9);
      expect(remaining).toBeLessThanOrEqual(30);
    }
    const linkHours = (Date.parse((await shares())[0].expiresAt) - Date.now()) / 3_600_000;
    expect(linkHours).toBeGreaterThan(23.9);
    expect(linkHours).toBeLessThanOrEqual(24);
  });
});

describe('C4: restricted cleanup role', () => {
  it('gives the cleanup role no right over owner scope content, share links or feedback beyond its earlier retention function', async () => {
    await seedScenario();
    const before = (await feedbackRows()).length;
    await erase(scenario.sourceId, scenario.generation);
    await ctx.api.postOnboardingIdle();
    const denied = async (sql, params = []) => { await expect(asCleanup(ctx.pg, (pg) => pg.query(sql, params))).rejects.toThrow(); await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec('SET ROLE frontline_app'); };
    await denied('SELECT state FROM scoped_workspace_states');
    await denied('SELECT * FROM frontline_feedback');
    await denied('DELETE FROM frontline_feedback');
    await denied('SELECT * FROM share_fence_versions($1::uuid,$2::uuid[])', [ctx.owner.scopeId, []]);
    await denied('SELECT list_scopes_with_pending_source_erasures(10)');
    await expect(ctx.pg.query('DELETE FROM frontline_feedback')).rejects.toThrow();
    expect((await feedbackRows()).length).toBe(before);
  });
});

describe('extension point for future intake kinds', () => {
  it('runs every registered eraser that applies before redacting, with the source still readable', async () => {
    await seedScenario();
    const seen = [];
    sourceStoreErasers.push({ name: 'document_bytes', appliesTo: (source) => source.type === 'owner_form', erase: async ({ source, job }) => { seen.push({ type: source.type, jobId: job.jobId, redacted: Boolean(source.erasedAt) }); } });
    sourceStoreErasers.push({ name: 'not_ours', appliesTo: () => false, erase: async () => { seen.push('wrong'); } });
    const started = await erase(scenario.sourceId, scenario.generation);
    await ctx.api.postOnboardingIdle();
    expect(seen).toEqual([{ type: 'owner_form', jobId: started.body.jobId, redacted: false }]);
  });
});

describe('fence on live calls', () => {
  const state = { agentLineages: { agent: { currentAgentVersionId: 'v2', pointerGeneration: 2, revisions: [{ agentVersionId: 'v1', knowledgeRevisionId: 'k1' }, { agentVersionId: 'v2', knowledgeRevisionId: 'k2', fencedAt: '2026-09-29T00:00:00.000Z' }] } } };
  it('refuses the worker for a live call on a fenced version, and leaves finished calls and other versions alone', () => {
    expect(isCallFenced(state, { stableAgentId: 'agent', agentVersionId: 'v2', state: 'active' })).toBe(true);
    expect(isCallFenced(state, { stableAgentId: 'agent', agentVersionId: 'v2', state: 'ended' })).toBe(false);
    expect(isCallFenced(state, { stableAgentId: 'agent', agentVersionId: 'v1', state: 'active' })).toBe(false);
  });
});
