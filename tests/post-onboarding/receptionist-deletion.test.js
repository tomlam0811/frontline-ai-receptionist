import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { backfillKnowledgeLibrary, lineageStatus, readLineage } from '../../server/api/post-onboarding/lineage.js';
import { DELETION_PHASES, runReceptionistDeletion, startReceptionistDeletion, sweepReceptionistDeletions } from '../../server/api/post-onboarding/receptionist-deletion.js';
import { startSourceErasure, runSourceErasure } from '../../server/api/post-onboarding/source-erasure.js';
import { createAnonymousRetention } from '../../server/api/retention.js';
import { startConnectedApi } from './connected-api.js';
import { asOwner, browserClient, hash, seedClaimedOwner } from './fixtures.js';
import { callerSays, guestFetch, scopeState, terminalPath, tokenOf } from './ui-calls.js';

// MR-D6, MR-J5, MR-S6: delete one receptionist. Acceptance MR-T9 (everything about it is gone, everything else stays)
// and MR-T10 (the job resumes after a crash). Real handler, real migrations and role grants on an in-process Postgres.
// Only the paid LiveKit provider is faked. Two receptionists share one scope (the limit is five); the second is built
// directly in state so the test controls its versions and records.
const SENTINEL_A = 'CONVERSATION-A-SENTINEL';
const SENTINEL_B = 'CONVERSATION-B-SENTINEL';
let ctx; let db; let two;

beforeEach(async () => { ctx = await startConnectedApi(); db = fromPglite(ctx.pg); });
afterEach(() => { ctx.restore(); });

const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
const agentPath = (id, suffix = '') => `/v1/agents/${id}${suffix}`;
const request = (method, path, body, client = ctx.ownerClient) => client.request(method, path, body ? { body } : {}).then(json);
const actorOf = (stableAgentId) => ({ scopeId: ctx.owner.scopeId, stableAgentId, creatorRef: null, versionNumbers: {} });
const stateNow = () => scopeState(ctx.pg, ctx.owner.scopeId);
const deletionJob = async () => Object.values((await stateNow()).receptionistDeletions ?? {})[0];

async function patchState(change) {
  await asOwner(ctx.pg, async () => {
    const state = (await ctx.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId])).rows[0].state;
    const next = (await change(state)) ?? state;
    await ctx.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1 WHERE owner_scope_id = $1', [ctx.owner.scopeId, JSON.stringify(next)]);
  });
}

/** Everything a finished conversation leaves in the scope, keyed by its demo. */
function addConversationRecords(state, demoId, text) {
  const at = new Date().toISOString();
  const add = (key, value) => { state[key] = { ...state[key], [demoId]: value }; };
  add('transcripts', [{ text, at }]);
  add('outcomes', { outcomeId: randomUUID(), summary: text });
  add('cases', { caseId: randomUUID(), note: text });
  add('requests', { note: text });
  add('workflows', { workflowInstanceId: `instance-${demoId}`, note: text });
  state.callerTurns = { ...state.callerTurns, [demoId]: [{ finalized: true, text, recordedAt: at }] };
  state.lookups = { ...state.lookups, [`lookup-${demoId}`]: { outcome: { demoId }, text } };
  state.receipts = { ...state.receipts, [`receipt-${demoId}`]: { workflowInstanceId: `instance-${demoId}`, text } };
}
/** @param {string} id @param {string | undefined} stableAgentId @param {string} agentVersionId */
const endedDemo = (id, stableAgentId, agentVersionId, mode = 'owner_test') => ({
  id, mode, stableAgentId, agentVersionId, state: 'ended', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString(),
});

/**
 * Two receptionists in one scope. A (the seeded one) has a second version, an older conversation on its first version,
 * a finished owner test with records, an unused link and a live shared call. B has one version that shares A's first
 * knowledge record, one finished conversation with records and one unused link.
 */
async function seedTwoReceptionists() {
  const A = ctx.owner.agentId;
  const B = randomUUID();
  const v2 = randomUUID(); const knowledgeV2 = randomUUID(); const mid = randomUUID(); const knowledgeMid = randomUUID();
  const older = randomUUID(); const bDemo = randomUUID();
  const now = new Date().toISOString();
  /** @type {string} */ let firstKnowledge = '';
  await patchState((state) => {
    firstKnowledge = state.agents[A].knowledgeRevisionId;
    state.knowledge[knowledgeV2] = { ...structuredClone(state.knowledge[firstKnowledge]), id: knowledgeV2 };
    state.agents[v2] = { ...structuredClone(state.agents[A]), id: v2, knowledgeRevisionId: knowledgeV2 };
    state.knowledge[knowledgeMid] = { ...structuredClone(state.knowledge[firstKnowledge]), id: knowledgeMid };
    state.agents[mid] = { ...structuredClone(state.agents[A]), id: mid, knowledgeRevisionId: knowledgeMid };
    state.agents[B] = { ...structuredClone(state.agents[A]), id: B };
    const revision = (agentVersionId, knowledgeRevisionId, parent) => ({ agentVersionId, knowledgeRevisionId, parentAgentVersionId: parent, kind: parent ? 'knowledge' : 'initial', createdAt: now, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null });
    state.agentLineages = {
      [A]: { stableAgentId: A, pointerGeneration: 3, currentAgentVersionId: v2, revisions: [revision(A, firstKnowledge, null), revision(mid, knowledgeMid, A), revision(v2, knowledgeV2, mid)] },
      [B]: { stableAgentId: B, name: 'Ava', businessName: 'Riverside Dental', pointerGeneration: 1, currentAgentVersionId: B, revisions: [revision(B, firstKnowledge, null)] },
    };
    state.demos = { ...state.demos, [older]: endedDemo(older, undefined, A, 'business_demo'), [bDemo]: endedDemo(bDemo, B, B) };
    addConversationRecords(state, older, SENTINEL_A);
    addConversationRecords(state, bDemo, SENTINEL_B);
    return backfillKnowledgeLibrary(state);
  });
  await ctx.ownerSql("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('agent',$1,$2,$3)", [B, ctx.owner.scopeId, ctx.owner.tenant]);
  const feedback = (agentId, label) => ctx.ownerSql(
    `INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
     VALUES ('owner','text','quality',$1,$2,$3,$3,'owner',$4,$5,$4,now() + interval '30 days')`, [label, ctx.owner.scopeId, agentId, hash(label), randomUUID()]);
  await feedback(A, 'feedback about A');
  await feedback(B, 'feedback about B');

  // The finished owner test on A's current version, with a spoken turn and the records a call leaves.
  const test = await ctx.startOwnerTest(v2);
  await ctx.workerCall(test, 'ready');
  await callerSays(ctx.pg, ctx.owner.scopeId, test.id, SENTINEL_A);
  const ended = await request('POST', agentPath(A, `/tests/${test.id}/end`), {});
  expect(ended, JSON.stringify(ended)).toMatchObject({ status: 200 });
  await patchState((state) => { addConversationRecords(state, test.id, SENTINEL_A); });
  // An unused link for each receptionist, then a live shared call on A.
  const unusedA = (await request('POST', agentPath(A, '/shares'), { expectedAgentVersionId: v2 })).body;
  const linkB = (await request('POST', agentPath(B, '/shares'), { expectedAgentVersionId: B })).body;
  expect(linkB.status).toBe('unused');
  const live = await ctx.startGuestCall();
  const before = await stateNow();
  return { A, B, v2, mid, knowledgeMid, knowledgeV2, firstKnowledge, older, bDemo, test, unusedA, linkB, live, before };
}
const grantRow = (id) => ctx.ownerSql('SELECT * FROM frontline_share_grants WHERE id = $1', [id]).then((result) => result.rows[0]);
const targetIds = () => ctx.ownerSql('SELECT target_id FROM frontline_claimed_targets WHERE owner_scope_id = $1', [ctx.owner.scopeId]).then((result) => result.rows.map((row) => row.target_id));
const feedbackCount = (agentId) => ctx.ownerSql('SELECT count(*)::int AS n FROM frontline_feedback WHERE stable_agent_id = $1', [agentId]).then((result) => result.rows[0].n);

describe('MR-T9 delete a receptionist', () => {
  it('revokes links, ends the live call, removes conversations and versions, and leaves the other receptionist and the library alone', async () => {
    two = await seedTwoReceptionists();
    const { A, B } = two;
    const callsBefore = ctx.voice.ended.length;
    const listed = (await request('GET', '/v1/me/agents')).body.agents;
    expect(listed.map((agent) => agent.stableAgentId).sort()).toEqual([A, B].sort());

    const deleted = await request('DELETE', agentPath(A));
    expect(deleted).toMatchObject({ status: 202, body: { stableAgentId: A, status: 'deleting', linksRevoked: 2 } });
    await ctx.api.postOnboardingIdle();

    // Links revoked and the live call ended before the records went.
    expect(ctx.voice.ended.length).toBeGreaterThan(callsBefore);
    expect(ctx.voice.ended).toContain(two.live.demo.id);
    expect(await grantRow(two.unusedA.shareId)).toBeUndefined();
    expect(await grantRow(two.live.share.shareId)).toBeUndefined();
    const reopened = await guestFetch(ctx.app)('/v1/shared/exchange', { body: { token: tokenOf(two.unusedA.url) } });
    expect([reopened.status, (await reopened.json()).reason]).toEqual([404, 'unavailable']);
    expect((await guestFetch(ctx.app)('/v1/shared/session', { method: 'GET', cookie: two.live.cookie })).status).toBe(401);

    // Gone from the owner's list and from every detail route.
    expect((await request('GET', '/v1/me/agents')).body.agents.map((agent) => [agent.stableAgentId, agent.status])).toEqual([[B, 'active']]);
    /** @type {[string, string, any?][]} */
    const routes = [['GET', '/summary'], ['GET', '/knowledge'], ['GET', '/capabilities'], ['GET', '/conversations'], ['GET', '/shares'], ['POST', '/shares', { expectedAgentVersionId: two.v2 }], ['POST', '/tests', { expectedAgentVersionId: two.v2 }], ['PATCH', '/name', { name: 'Zed' }], ['POST', '/pause', {}], ['POST', '/resume', {}]];
    for (const [method, suffix, body] of routes) {
      expect((await request(method, agentPath(A, suffix), body)).status, `${method} ${suffix}`).toBe(404);
    }

    const state = await stateNow();
    // Conversations, transcripts and their records.
    for (const demoId of [two.older, two.test.id, two.live.demo.id]) {
      for (const key of ['demos', 'transcripts', 'callerTurns', 'outcomes', 'cases', 'requests', 'workflows']) expect(state[key]?.[demoId], `${key} ${demoId}`).toBeUndefined();
      expect(state.lookups?.[`lookup-${demoId}`]).toBeUndefined();
      expect(state.receipts?.[`receipt-${demoId}`]).toBeUndefined();
    }
    expect(JSON.stringify(state)).not.toContain(SENTINEL_A);
    // Versions, the snapshot only A used, and the lineage. The snapshot B also uses and the unrelated one stay.
    expect(state.agents[A]).toBeUndefined();
    expect(state.agents[two.v2]).toBeUndefined();
    expect(state.agents[two.mid]).toBeUndefined();
    expect(state.knowledge[two.knowledgeMid]).toBeUndefined();
    // The library was built from the newest snapshot, so that one stays as its compile reference, like the one B uses.
    expect(state.knowledgeLibrary.materializedFromKnowledgeRevisionId).toBe(two.knowledgeV2);
    expect(state.knowledge[two.knowledgeV2]).toBeDefined();
    expect(state.knowledge[two.firstKnowledge]).toBeDefined();
    expect(state.knowledge.secret).toBeDefined();
    expect(state.agentLineages[A]).toBeUndefined();
    expect(Object.keys(state.agentLineages)).toEqual([B]);
    // Nothing else changed: the other receptionist, its conversation, the library.
    expect(state.agentLineages[B]).toEqual(two.before.agentLineages[B]);
    expect(state.agents[B]).toEqual(two.before.agents[B]);
    expect(state.knowledgeLibrary).toEqual(two.before.knowledgeLibrary);
    expect(state.demos[two.bDemo]).toEqual(two.before.demos[two.bDemo]);
    expect(state.transcripts[two.bDemo]).toEqual(two.before.transcripts[two.bDemo]);
    expect(JSON.stringify(state)).toContain(SENTINEL_B);
    // Rows outside the scope JSON: A's links and target are gone, B's stay, feedback already sent stays.
    expect(await targetIds()).toEqual([B]);
    expect(await grantRow(two.linkB.shareId)).toMatchObject({ status: 'unused' });
    expect(await feedbackCount(A)).toBe(1);
    expect(await feedbackCount(B)).toBe(1);
    expect((await request('GET', agentPath(B, '/summary'))).body).toMatchObject({ stableAgentId: B, name: 'Ava', status: 'active' });
    expect((await request('GET', agentPath(B, '/conversations'))).body.conversations.map((item) => item.conversationId)).toEqual([two.bDemo]);
    const job = await deletionJob();
    expect(job).toMatchObject({ stableAgentId: A, status: 'completed', audit: { conversations: 3 } });
  });

  it('shows the receptionist as deleting, and gone to every owner and guest path, from the moment the request is accepted', async () => {
    two = await seedTwoReceptionists();
    const { A, B } = two;
    const started = await startReceptionistDeletion({ db, actor: actorOf(A), endLiveCall: terminalPath(ctx.pg) });
    expect(started).toMatchObject({ created: true, response: { stableAgentId: A, status: 'deleting', linksRevoked: 2 } });
    const state = await stateNow();
    expect(lineageStatus(readLineage(state, A))).toBe('deleting');
    expect(readLineage(state, A).revisions.every((revision) => revision.fencedAt)).toBe(true);

    const listed = (await request('GET', '/v1/me/agents')).body.agents;
    expect(listed.map((agent) => [agent.stableAgentId, agent.status]).sort()).toEqual([[A, 'deleting'], [B, 'active']].sort());
    /** @type {[string, string, any?][]} */
    const fenced = [['GET', '/summary'], ['GET', '/knowledge'], ['GET', '/conversations'], ['GET', '/shares'], ['POST', '/shares', { expectedAgentVersionId: two.v2 }], ['POST', '/tests', { expectedAgentVersionId: two.v2 }], ['POST', '/feedback', { category: 'quality', inputMethod: 'text', text: 'hello' }], ['POST', '/pause', {}], ['POST', '/resume', {}]];
    for (const [method, suffix, body] of fenced) {
      expect((await request(method, agentPath(A, suffix), body)).status, `${method} ${suffix}`).toBe(404);
    }
    // Links are revoked and the live call ended, but the records stay until the job runs.
    expect(await grantRow(two.unusedA.shareId)).toMatchObject({ status: 'revoked' });
    expect(await grantRow(two.live.share.shareId)).toMatchObject({ status: 'revoked' });
    expect((await ctx.demoRecord(two.live.demo.id)).state).toBe('ended');
    // A link that was created just before the fence still cannot start or open.
    const guest = guestFetch(ctx.app);
    const opened = await guest('/v1/shared/exchange', { body: { token: tokenOf(two.unusedA.url) } });
    expect(opened.status).toBe(404);
    expect((await guest('/v1/shared/start', { cookie: two.live.cookie })).status).toBeGreaterThanOrEqual(401);
  });

  it('refuses a guest link that was not revoked yet once the receptionist is deleting', async () => {
    two = await seedTwoReceptionists();
    const link = (await request('POST', agentPath(two.A, '/shares'), { expectedAgentVersionId: two.v2 })).body;
    await patchState((state) => ({ ...state, agentLineages: { ...state.agentLineages, [two.A]: { ...state.agentLineages[two.A], status: 'deleting' } } }));
    expect(await grantRow(link.shareId)).toMatchObject({ status: 'unused' });
    const opened = await guestFetch(ctx.app)('/v1/shared/exchange', { body: { token: tokenOf(link.url) } });
    expect([opened.status, (await opened.json()).reason]).toEqual([404, 'unavailable']);
  });

  it('adds a receptionist while the first one is being deleted, starting from one that is not', async () => {
    two = await seedTwoReceptionists();
    await startReceptionistDeletion({ db, actor: actorOf(two.A), endLiveCall: terminalPath(ctx.pg) });
    const added = await ctx.ownerClient.request('POST', '/v1/me/agents', { body: { name: 'Zoe' }, headers: { 'idempotency-key': randomUUID() } }).then(json);
    expect(added, JSON.stringify(added)).toMatchObject({ status: 201, body: { name: 'Zoe', status: 'active' } });
    const listed = (await request('GET', '/v1/me/agents')).body.agents;
    expect(listed.map((agent) => [agent.stableAgentId, agent.status]).sort()).toEqual([[two.A, 'deleting'], [two.B, 'active'], [added.body.stableAgentId, 'active']].sort());
  });

  it('answers a second delete with the same job, then 404 once the receptionist is gone', async () => {
    two = await seedTwoReceptionists();
    await startReceptionistDeletion({ db, actor: actorOf(two.A), endLiveCall: terminalPath(ctx.pg) });
    const again = await request('DELETE', agentPath(two.A));
    expect(again).toMatchObject({ status: 202, body: { stableAgentId: two.A, status: 'deleting' } });
    await ctx.api.postOnboardingIdle();
    expect(Object.keys((await stateNow()).receptionistDeletions)).toHaveLength(1);
    expect((await deletionJob()).status).toBe('pending');
    expect(await sweepReceptionistDeletions({ db, endLiveCall: terminalPath(ctx.pg) })).toEqual({ scopes: 1, jobs: 1, completed: 1 });
    expect((await request('DELETE', agentPath(two.A))).status).toBe(404);
  });

  it('deletes the only receptionist and leaves the business library and account usable', async () => {
    const A = ctx.owner.agentId;
    const before = await stateNow();
    const deleted = await request('DELETE', agentPath(A));
    expect(deleted.status).toBe(202);
    await ctx.api.postOnboardingIdle();
    expect((await request('GET', '/v1/me/agents')).body.agents).toEqual([]);
    const state = await stateNow();
    expect(state.agentLineages).toEqual({});
    expect(state.agents[A]).toBeUndefined();
    expect(state.workspaces).toEqual(before.workspaces);
    // Knowledge that lived in the receptionist's own base moved into the library first, and stays there.
    expect(Object.keys(state.knowledgeLibrary.entries).length).toBeGreaterThan(0);
    expect(await targetIds()).toEqual([]);
    expect((await deletionJob()).status).toBe('completed');
  });
});

describe('who may delete', () => {
  it('answers 404 for another owner and changes nothing', async () => {
    two = await seedTwoReceptionists();
    const intruder = await seedClaimedOwner(ctx.pg, { researched: true });
    await ctx.pg.exec('SET ROLE frontline_app');
    const attempt = await request('DELETE', agentPath(two.A), undefined, browserClient(ctx.app, intruder.authToken));
    expect(attempt.status).toBe(404);
    await ctx.api.postOnboardingIdle();
    const state = await stateNow();
    expect(lineageStatus(readLineage(state, two.A))).toBe('active');
    expect(state.receptionistDeletions).toBeUndefined();
    expect(await grantRow(two.unusedA.shareId)).toMatchObject({ status: 'unused' });
    // The intruder's own receptionist is not touched by a delete aimed at the first owner's id either.
    expect((await request('GET', agentPath(intruder.agentId, '/summary'), undefined, browserClient(ctx.app, intruder.authToken))).status).toBe(200);
  });

  it('needs a sign-in and the CSRF pair', async () => {
    const A = ctx.owner.agentId;
    expect((await request('DELETE', agentPath(A), undefined, browserClient(ctx.app, null))).status).toBe(404);
    const noCsrf = await ctx.app.fetch(`${ctx.app.baseUrl}${agentPath(A)}`, { method: 'DELETE', headers: { origin: ctx.app.baseUrl, cookie: `fl_auth=${ctx.owner.authToken}` } });
    expect(noCsrf.status).toBe(403);
    expect(lineageStatus(readLineage(await stateNow(), A))).toBe('active');
  });

  it('is limited by the owner write budget', async () => {
    ctx.restore();
    ctx = await startConnectedApi({ apiOptions: { postOnboarding: { limits: { ownerWrite: 1, ownerRead: 100, guest: 100 } } } });
    const A = ctx.owner.agentId;
    const first = await request('DELETE', agentPath(A));
    const second = await request('DELETE', agentPath(A));
    expect([first.status, second.status]).toEqual([202, 429]);
  });

  it('does not break the legacy GET of an agent setup', async () => {
    const legacy = await ctx.ownerClient.request('GET', agentPath(ctx.owner.agentId));
    expect(legacy.status).not.toBe(500);
  });
});

describe('MR-T10 the job resumes after a crash', () => {
  const stoppingPoints = [null, ...DELETION_PHASES];
  const removedByNow = async (A) => { const state = await stateNow(); return { lineage: Boolean(state.agentLineages?.[A]), agent: Boolean(state.agents?.[A]) }; };

  it.each(stoppingPoints)('finishes with the sweep after stopping at %s', async (phase) => {
    two = await seedTwoReceptionists();
    const { A, B } = two;
    const endLiveCall = terminalPath(ctx.pg);
    const { jobId } = await startReceptionistDeletion({ db, actor: actorOf(A), endLiveCall });
    if (phase) {
      const partial = await runReceptionistDeletion({ db, scopeId: ctx.owner.scopeId, jobId, endLiveCall, stopAfter: phase });
      expect(partial.status).toBe('pending');
      expect(DELETION_PHASES.slice(0, DELETION_PHASES.indexOf(phase) + 1).every((name) => partial.phases[name])).toBe(true);
      expect(DELETION_PHASES.slice(DELETION_PHASES.indexOf(phase) + 1).every((name) => !partial.phases[name])).toBe(true);
    }
    // Until the lineage step the receptionist is still fenced and listed as deleting, never reachable.
    const listed = (await request('GET', '/v1/me/agents')).body.agents.find((agent) => agent.stableAgentId === A);
    if (!phase || DELETION_PHASES.indexOf(phase) < DELETION_PHASES.indexOf('lineageRemovedAt')) expect(listed?.status).toBe('deleting');
    expect((await request('GET', agentPath(A, '/summary'))).status).toBe(404);

    const swept = await sweepReceptionistDeletions({ db, endLiveCall });
    expect(swept).toEqual({ scopes: 1, jobs: 1, completed: 1 });
    expect((await deletionJob()).status).toBe('completed');
    const state = await stateNow();
    expect(state.agentLineages[A]).toBeUndefined();
    expect(state.agents[A]).toBeUndefined();
    expect(Object.keys(state.demos)).toEqual([two.bDemo]);
    expect(await targetIds()).toEqual([B]);
    expect((await request('GET', '/v1/me/agents')).body.agents.map((agent) => agent.stableAgentId)).toEqual([B]);
    expect(state.knowledgeLibrary).toEqual(two.before.knowledgeLibrary);

    // A second sweep and a repeated run change nothing.
    const after = await ctx.ownerSql('SELECT version FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId]);
    expect(await sweepReceptionistDeletions({ db, endLiveCall })).toEqual({ scopes: 0, jobs: 0, completed: 0 });
    expect((await runReceptionistDeletion({ db, scopeId: ctx.owner.scopeId, jobId, endLiveCall })).status).toBe('completed');
    expect((await ctx.ownerSql('SELECT version FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId])).rows).toEqual(after.rows);
  });

  it('keeps the job pending and the records in place while a call is still live and no terminal path is available', async () => {
    two = await seedTwoReceptionists();
    const { jobId } = await startReceptionistDeletion({ db, actor: actorOf(two.A) });
    const waiting = await runReceptionistDeletion({ db, scopeId: ctx.owner.scopeId, jobId });
    expect(waiting).toMatchObject({ status: 'pending', failureCode: null });
    expect((await stateNow()).demos[two.live.demo.id]).toBeDefined();
    expect(await removedByNow(two.A)).toEqual({ lineage: true, agent: true });
    // The call ends through its own path, then the sweep finishes the job.
    await terminalPath(ctx.pg)({ scopeId: ctx.owner.scopeId, demoId: two.live.demo.id });
    expect(await sweepReceptionistDeletions({ db })).toEqual({ scopes: 1, jobs: 1, completed: 1 });
    expect(await removedByNow(two.A)).toEqual({ lineage: false, agent: false });
  });

  it('records a failure when the live call cannot be ended, stays fenced, and finishes on a later sweep', async () => {
    two = await seedTwoReceptionists();
    const { jobId } = await startReceptionistDeletion({ db, actor: actorOf(two.A) });
    const broken = async () => { throw new Error('provider down'); };
    const failed = await runReceptionistDeletion({ db, scopeId: ctx.owner.scopeId, jobId, endLiveCall: broken });
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'sessions_not_ended', attempts: 1 });
    expect((await request('GET', '/v1/me/agents')).body.agents.find((agent) => agent.stableAgentId === two.A).status).toBe('deleting');
    expect(await sweepReceptionistDeletions({ db, endLiveCall: terminalPath(ctx.pg) })).toEqual({ scopes: 1, jobs: 1, completed: 1 });
    expect((await deletionJob()).status).toBe('completed');
  });

  it('stops retrying by itself after three failed attempts, and a new delete request resumes it', async () => {
    two = await seedTwoReceptionists();
    const { jobId } = await startReceptionistDeletion({ db, actor: actorOf(two.A) });
    const broken = async () => { throw new Error('provider down'); };
    for (let attempt = 0; attempt < 3; attempt += 1) await runReceptionistDeletion({ db, scopeId: ctx.owner.scopeId, jobId, endLiveCall: broken });
    expect(await sweepReceptionistDeletions({ db, endLiveCall: terminalPath(ctx.pg) })).toEqual({ scopes: 0, jobs: 0, completed: 0 });
    const resumed = await request('DELETE', agentPath(two.A));
    expect(resumed.status).toBe(202);
    await ctx.api.postOnboardingIdle();
    expect((await deletionJob()).status).toBe('completed');
  });

  it('is finished by the retention worker sweep as the runtime role', async () => {
    two = await seedTwoReceptionists();
    await terminalPath(ctx.pg)({ scopeId: ctx.owner.scopeId, demoId: two.live.demo.id });
    await startReceptionistDeletion({ db, actor: actorOf(two.A), endLiveCall: terminalPath(ctx.pg) });
    const roles = [];
    const poolAs = (role) => {
      const run = async (sql, params) => { roles.push({ role, sql }); await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec(`SET ROLE ${role}`); return ctx.pg.query(sql, params); };
      return { query: run, connect: async () => ({ query: run, release() {} }), end: async () => {} };
    };
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    const counts = await retention.sweepPostOnboarding();
    await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec('SET ROLE frontline_app');
    expect(counts).toMatchObject({ deletionJobs: 1, deletionsCompleted: 1 });
    expect((await deletionJob()).status).toBe('completed');
    expect(roles.filter((item) => item.role === 'frontline_cleanup').every((item) => item.sql.includes('cleanup_expired_post_onboarding') || item.sql.includes('cleanup_expired_anonymous_scopes'))).toBe(true);
    await retention.close();
  });
});

describe('a source removal requested by a receptionist that is then deleted', () => {
  it('still completes', async () => {
    const A = ctx.owner.agentId;
    const view = (await request('GET', agentPath(A, '/knowledge'))).body;
    const removal = await startSourceErasure({ db, actor: actorOf(A), sourceId: view.sources[0].sourceId, body: { confirm: true, expectedPointerGeneration: view.pointerGeneration } });
    const { jobId } = await startReceptionistDeletion({ db, actor: actorOf(A) });
    expect((await runReceptionistDeletion({ db, scopeId: ctx.owner.scopeId, jobId })).status).toBe('completed');
    expect((await stateNow()).agentLineages[A]).toBeUndefined();
    const erased = await runSourceErasure({ db, scopeId: ctx.owner.scopeId, jobId: removal.jobId });
    expect(erased.status).toBe('completed');
  });
});
