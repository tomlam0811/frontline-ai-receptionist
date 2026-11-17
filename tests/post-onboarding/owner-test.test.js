import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { ownerTestDayKey } from '../../server/api/post-onboarding/owner-test.js';
import { fromPglite, inOwnerScope } from '../../server/api/post-onboarding/database.js';
import { readDemo, updateDemo } from '../../server/api/post-onboarding/demo-store.js';
import { getConversation, prepareRecaps } from '../../server/api/post-onboarding/conversations.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner, startServer } from './fixtures.js';

let pg; let db; let app; let voice; let clock;
// The database stamps deadlines with its own now(), so the fake clock starts at the wall clock and moves in offsets from it.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const secondsAfterStart = (seconds) => new Date(T0.getTime() + seconds * 1000);
let keyCounter = 0;
const key = () => `k-${++keyCounter}`;
const json = async (response) => ({ status: response.status, body: await response.json() });

/** What the real terminal path does to the reservation and the demo (connection PO-C1 supplies the real one). */
async function terminal({ scopeId, demoId }) {
  const demo = await readDemo(db, scopeId, demoId);
  await inOwnerScope(db, scopeId, (tx) => tx.query("SELECT settle_voice_start($1::uuid,'completed')", [demo.reservationId]));
  await updateDemo(db, scopeId, demoId, (current) => ({ state: 'ended', endedAt: current.endedAt ?? clock.toISOString(), terminalReason: 'caller_ended', voiceCleanupCompleted: true }));
  return { demoId, state: 'ended' };
}
/** Stands in for the voice worker writing what it heard: the caller's finalized turns. */
async function workerWrites(scopeId, fn) {
  await asOwner(pg, async () => {
    const state = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId])).rows[0].state;
    fn(state);
    await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [scopeId, JSON.stringify(state)]);
  });
}
const callerTurn = (demoId, text, at, sequence = 1) => (state) => { (state.callerTurns ??= {})[demoId] ??= []; state.callerTurns[demoId].push({ callerTurnId: randomUUID(), clientTurnId: randomUUID(), demoId, sequence, text, finalized: true, recordedAt: at, workflowRevision: 1 }); };
const stateOf = (scopeId) => asOwner(pg, async () => (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId])).rows[0].state);

async function newOwner(options = {}) {
  const owner = await seedClaimedOwner(pg, { researched: true, ...options });
  await pg.exec('SET ROLE frontline_app');
  return { owner, client: browserClient(app, owner.authToken) };
}
const startTest = (who, version = who.owner.agentId) => who.client.request('POST', `/v1/agents/${who.owner.agentId}/tests`, { body: { expectedAgentVersionId: version } }).then(json);
const bearerPost = (path, body, token = 'worker-ok') => app.fetch(`${app.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = fromPglite(pg);
  await pg.exec('SET ROLE frontline_app');
  clock = T0;
});
afterAll(async () => { await app?.close(); });

let scopeOfWorker;
beforeAll(() => {
  voice = fakeVoice();
  app = startServer(pg, {
    voice, now: () => clock, guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 1_000_000, reservedCents: 100, globalConcurrent: 500, scopeDailyMax: 15 }, limits: { ownerWrite: 10_000, ownerRead: 10_000 }, endOwnerDemo: terminal,
    worker: async (request) => (request.headers.authorization === 'Bearer worker-ok' && scopeOfWorker ? { scopeId: scopeOfWorker } : null),
  });
});

describe('owner test calls', () => {
  it('uses the Pacific calendar date for the owner allowance across daylight-saving offsets', async () => {
    expect(ownerTestDayKey('2026-10-02T06:59:59.999Z')).toBe('2026-10-01');
    expect(ownerTestDayKey('2026-10-02T07:00:00.000Z')).toBe('2026-10-02');
    expect(ownerTestDayKey('2026-01-15T07:59:59.999Z')).toBe('2026-01-14');
    expect(ownerTestDayKey('2026-01-15T08:00:00.000Z')).toBe('2026-01-15');
  });

  it('uses Pacific midnight only for owner-test reservations and keeps shared guests on UTC', async () => {
    const { rows } = await pg.query(`SELECT
      frontline_voice_scope_day_start('owner_test', '2026-10-02T06:59:59.999Z') AS owner_before_midnight,
      frontline_voice_scope_day_start('owner_test', '2026-10-02T07:00:00.000Z') AS owner_at_midnight,
      frontline_voice_scope_day_start('owner_test', '2026-01-15T07:59:59.999Z') AS owner_winter_before_midnight,
      frontline_voice_scope_day_start('owner_test', '2026-01-15T08:00:00.000Z') AS owner_winter_at_midnight,
      frontline_voice_scope_day_start('shared_guest', '2026-10-02T06:59:59.999Z') AS guest_utc_start`);
    expect(rows[0]).toMatchObject({
      owner_before_midnight: new Date('2026-10-01T07:00:00.000Z'),
      owner_at_midnight: new Date('2026-10-02T07:00:00.000Z'),
      owner_winter_before_midnight: new Date('2026-01-14T08:00:00.000Z'),
      owner_winter_at_midnight: new Date('2026-01-15T08:00:00.000Z'),
      guest_utc_start: new Date('2026-10-02T00:00:00.000Z'),
    });
  });

  it('starts a test on the current version and records a private demo with a 30 day retention', async () => {
    const who = await newOwner();
    const { status, body } = await startTest(who);
    expect(status).toBe(201);
    expect(body).toMatchObject({ mode: 'owner_test', agentVersionId: who.owner.agentId, livekitUrl: 'wss://voice.test' });
    expect(typeof body.participantToken).toBe('string');
    const demo = (await stateOf(who.owner.scopeId)).demos[body.demoId];
    expect(demo).toMatchObject({ mode: 'owner_test', state: 'waiting', stableAgentId: who.owner.agentId, agentVersionId: who.owner.agentId });
    expect((Date.parse(demo.expiresAt) - clock.getTime()) / 86_400_000).toBeCloseTo(30, 1);
    expect(voice.started).toContain(body.demoId);
  });

  it('allows one active call per Blake', async () => {
    const who = await newOwner();
    expect((await startTest(who)).status).toBe(201);
    expect(await startTest(who)).toMatchObject({ status: 409, body: { title: 'agent_busy' } });
  });

  it('refuses a stale version and names the current one', async () => {
    const who = await newOwner();
    expect(await startTest(who, randomUUID())).toMatchObject({ status: 409, body: { title: 'stale_agent_version', currentAgentVersionId: who.owner.agentId, currentPointerGeneration: 1 } });
  });

  it('a later publish does not change the version a running test uses, and the next test uses the new one', async () => {
    const who = await newOwner();
    const running = await startTest(who);
    const view = (await (await who.client.request('GET', `/v1/agents/${who.owner.agentId}/knowledge`)).json());
    const created = await json(await who.client.request('POST', `/v1/agents/${who.owner.agentId}/knowledge-updates`, { body: { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, op: 'add', group: 'services', value: 'Whitening' }, headers: { 'idempotency-key': key() } }));
    const applied = await json(await who.client.request('POST', `/v1/agents/${who.owner.agentId}/knowledge-updates/${created.body.update.updateId}/apply`, { body: { expectedVersion: 1, decisions: created.body.update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' })) }, headers: { 'idempotency-key': key() } }));
    const nextVersion = applied.body.update.appliedAgentVersionId;
    expect((await stateOf(who.owner.scopeId)).demos[running.body.demoId].agentVersionId).toBe(who.owner.agentId);
    await terminal({ scopeId: who.owner.scopeId, demoId: running.body.demoId });
    expect(await startTest(who, who.owner.agentId)).toMatchObject({ status: 409, body: { title: 'stale_agent_version' } });
    const next = await startTest(who, nextVersion);
    expect(next).toMatchObject({ status: 201, body: { agentVersionId: nextVersion } });
  });

  it('stops after 3 starts in a Pacific calendar day for the owner scope, even with the production limit of 15 for other calls', async () => {
    const who = await newOwner();
    for (let index = 0; index < 3; index += 1) {
      const started = await startTest(who);
      expect(started.status).toBe(201);
      await terminal({ scopeId: who.owner.scopeId, demoId: started.body.demoId });
    }
    expect(await startTest(who)).toMatchObject({ status: 429, body: { title: 'test_limit_reached', detail: "You've used today's 3 test calls. The limit resets at midnight Pacific time." } });
  });

  it('counts reservations by the Pacific day when the UTC and Pacific dates differ', async () => {
    const who = await newOwner();
    for (let index = 0; index < 3; index += 1) {
      const started = await startTest(who);
      expect(started.status).toBe(201);
      await terminal({ scopeId: who.owner.scopeId, demoId: started.body.demoId });
    }

    const { rows } = await pg.query(`SELECT
      date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS utc_start,
      frontline_voice_scope_day_start('owner_test', now()) AS pacific_start`);
    const boundary = Math.min(new Date(rows[0].utc_start).getTime(), new Date(rows[0].pacific_start).getTime()) + 60_000;
    const representedDay = ownerTestDayKey(new Date(boundary));
    await asOwner(pg, () => pg.query(
      "UPDATE voice_start_reservations SET created_at = $1 WHERE owner_scope_id = $2 AND mode = 'owner_test'",
      [new Date(boundary).toISOString(), who.owner.scopeId],
    ));

    const fourth = await startTest(who);
    if (representedDay === ownerTestDayKey(clock)) {
      expect(fourth).toMatchObject({ status: 429, body: { title: 'test_limit_reached' } });
    } else {
      expect(fourth.status).toBe(201);
      await terminal({ scopeId: who.owner.scopeId, demoId: fourth.body.demoId });
    }
  });

  it('a failed start releases the reservation, so the retry works and does not count against the day', async () => {
    const who = await newOwner();
    voice.failStart = true;
    expect(await startTest(who)).toMatchObject({ status: 503, body: { title: 'voice_unavailable' } });
    voice.failStart = false;
    for (let index = 0; index < 3; index += 1) {
      const started = await startTest(who);
      expect(started.status).toBe(201);
      await terminal({ scopeId: who.owner.scopeId, demoId: started.body.demoId });
    }
  });

  it('keeps the reservation when the room cannot be deleted, so no second call can start', async () => {
    const who = await newOwner();
    voice.failStart = true; voice.failEnd = true;
    expect((await startTest(who)).status).toBe(503);
    voice.failStart = false; voice.failEnd = false;
    expect(await startTest(who)).toMatchObject({ status: 409, body: { title: 'agent_busy' } });
  });

  it('is limited to the owner of that agent and needs sign-in', async () => {
    const one = await newOwner(); const two = await newOwner();
    const crossed = await two.client.request('POST', `/v1/agents/${one.owner.agentId}/tests`, { body: { expectedAgentVersionId: one.owner.agentId } });
    expect(crossed.status).toBe(404);
    expect((await browserClient(app, null).request('POST', `/v1/agents/${one.owner.agentId}/tests`, { body: { expectedAgentVersionId: one.owner.agentId } })).status).toBe(404);
  });

  it('reports the result to its owner only, and marks the version tested only if the owner spoke', async () => {
    const who = await newOwner(); const stranger = await newOwner();
    const silent = await startTest(who);
    const path = `/v1/agents/${who.owner.agentId}/tests/${silent.body.demoId}`;
    expect((await json(await who.client.request('GET', `${path}/result`))).body).toMatchObject({ demoId: silent.body.demoId, mode: 'owner_test', closingPolicy: 'test_summary', versionNumber: 1 });
    expect((await stranger.client.request('GET', `/v1/agents/${stranger.owner.agentId}/tests/${silent.body.demoId}/result`)).status).toBe(404);
    expect((await json(await who.client.request('POST', `${path}/end`, { body: {} }))).status).toBe(200);
    expect((await stateOf(who.owner.scopeId)).agentLineages?.[who.owner.agentId]?.revisions?.[0]?.lastTestedAt ?? null).toBeNull();

    const spoken = await startTest(who);
    await workerWrites(who.owner.scopeId, callerTurn(spoken.body.demoId, 'What time do you close on Fridays?', clock.toISOString()));
    await who.client.request('POST', `/v1/agents/${who.owner.agentId}/tests/${spoken.body.demoId}/end`, { body: {} });
    const lineage = (await stateOf(who.owner.scopeId)).agentLineages[who.owner.agentId];
    expect(lineage.revisions[0].lastTestedAt).toBe(clock.toISOString());
    expect(lineage.revisions[0].ownerReviewedAt).toBeNull();
    const view = await (await who.client.request('GET', `/v1/agents/${who.owner.agentId}/knowledge`)).json();
    expect((await json(await who.client.request('POST', `/v1/agents/${who.owner.agentId}/versions/${who.owner.agentId}/review`, { body: { expectedPointerGeneration: view.pointerGeneration } }))).status).toBe(200);
  });
});

describe('conversation history', () => {
  it('lists conversations of every version, newest first, with pages, and hides other owners', async () => {
    const who = await newOwner(); const stranger = await newOwner();
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      clock = new Date(T0.getTime() + index * 60_000);
      const started = await startTest(who);
      ids.push(started.body.demoId);
      await workerWrites(who.owner.scopeId, (state) => { Object.assign(state.demos[started.body.demoId], { startedAt: clock.toISOString(), endedAt: new Date(clock.getTime() + 95_000).toISOString() }); });
      await terminal({ scopeId: who.owner.scopeId, demoId: started.body.demoId });
    }
    await workerWrites(who.owner.scopeId, (state) => {
      state.demos['0a0a0a0a-0000-4000-8000-000000000001'] = { id: '0a0a0a0a-0000-4000-8000-000000000001', mode: 'business_demo', agentVersionId: who.owner.agentId, state: 'ended', createdAt: '2026-09-01T09:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z' };
      state.demos['0a0a0a0a-0000-4000-8000-000000000002'] = { id: '0a0a0a0a-0000-4000-8000-000000000002', mode: 'frontline_qa', agentVersionId: null, state: 'ended', createdAt: '2026-09-02T09:00:00.000Z' };
    });
    clock = new Date(T0.getTime() + 600_000);
    const page1 = await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations?limit=2`));
    expect(page1.body.conversations.map((item) => item.conversationId)).toEqual([ids[2], ids[1]]);
    expect(page1.body.conversations[0]).toMatchObject({ origin: 'owner_test', durationSeconds: 95, versionLabel: 'Version 1', hasBobTranscript: false, requestLeftOpen: false });
    const page2 = await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations?limit=2&cursor=${page1.body.nextCursor}`));
    expect(page2.body.conversations.map((item) => item.conversationId)).toEqual([ids[0], '0a0a0a0a-0000-4000-8000-000000000001']);
    expect(page2.body.conversations[1].origin).toBe('trial');
    expect(page2.body.nextCursor).toBeNull();
    expect((await json(await stranger.client.request('GET', `/v1/agents/${stranger.owner.agentId}/conversations`))).body.conversations).toEqual([]);
    expect((await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations?limit=500`)).status).toBe(400);
    expect((await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations?cursor=bad`)).status).toBe(400);
    clock = T0;
  });

  it('shows a detail with the caller side only, and an honest notice, until Blake is recorded', async () => {
    const who = await newOwner(); const stranger = await newOwner();
    const started = await startTest(who);
    const demoId = started.body.demoId;
    await workerWrites(who.owner.scopeId, callerTurn(demoId, 'Do you fix cracked teeth?', secondsAfterStart(5).toISOString()));
    const detail = await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ conversationId: demoId, origin: 'owner_test', transcriptNotice: 'bob_side_not_recorded', transcript: [{ seq: 1, speaker: 'caller', text: 'Do you fix cracked teeth?' }] });
    expect(detail.body.summary).toMatchObject({ demoId, callerTurnCount: 1 });
    expect((await stranger.client.request('GET', `/v1/agents/${stranger.owner.agentId}/conversations/${demoId}`)).status).toBe(404);
    expect((await stranger.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`)).status).toBe(404);
  });

  it('VA-T16: marks a Needs review note done, keeps it after reload, undoes it, and hides it from other owners', async () => {
    const who = await newOwner(); const stranger = await newOwner();
    const demoId = (await startTest(who)).body.demoId;
    const recordId = randomUUID(); const caseId = randomUUID();
    await workerWrites(who.owner.scopeId, (state) => {
      (state.outcomes ??= {})[demoId] = [{ recordId, demoId, workflowInstanceId: randomUUID(), kind: 'service_request', fields: { callerName: 'Tom Lam', contactPhone: '(408) 555-2147', serviceNeed: 'Driveway washing' },
        receiptId: null, savedAt: T0.toISOString(), deliveryState: 'not_sent', reviewStatus: 'needs_review', reviewedAt: null, missingFields: ['propertyCity'], endedBecause: 'caller_ended' }];
      (state.cases ??= {})[demoId] = [{ recordId: caseId, demoId, kind: 'complaint', context: { summary: 'Late crew', callerTurnIds: [] }, fields: { summary: 'Late crew', contactEmail: 'ana@example.com' } }];
    });
    const path = (id, agentId = who.owner.agentId) => `/v1/agents/${agentId}/conversations/${demoId}/outcomes/${id}/review`;
    const done = await json(await who.client.request('POST', path(recordId), { body: { reviewStatus: 'done' } }));
    expect(done).toMatchObject({ status: 200, body: { record: { recordId, reviewStatus: 'done', reviewedAt: T0.toISOString(), nextStep: 'Call Tom at (408) 555-2147 to ask where the job is.' } } });
    let detail = (await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`))).body;
    expect(detail.outcomes.requests[0]).toMatchObject({ reviewStatus: 'done', nextStep: 'Call Tom at (408) 555-2147 to ask where the job is.' });
    expect(detail.outcomes.cases[0]).toMatchObject({ reviewStatus: 'needs_review', nextStep: 'Email ana@example.com about their complaint.' });
    const caseDone = await json(await who.client.request('POST', path(caseId), { body: { reviewStatus: 'done' } }));
    expect(caseDone.body.record).toMatchObject({ recordId: caseId, reviewStatus: 'done' });
    const undone = await json(await who.client.request('POST', path(recordId), { body: { reviewStatus: 'needs_review' } }));
    expect(undone.body.record).toMatchObject({ reviewStatus: 'needs_review', reviewedAt: null });
    detail = (await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`))).body;
    expect(detail.outcomes.requests[0].reviewStatus).toBe('needs_review');
    expect((await who.client.request('POST', path(randomUUID()), { body: { reviewStatus: 'done' } })).status).toBe(404);
    expect((await stranger.client.request('POST', path(recordId), { body: { reviewStatus: 'done' } })).status).toBe(404);
    expect((await stranger.client.request('POST', path(recordId, stranger.owner.agentId), { body: { reviewStatus: 'done' } })).status).toBe(404);
    expect((await who.client.request('POST', path(recordId), { body: { reviewStatus: 'archived' } })).status).toBe(400);
    expect((await who.client.request('POST', path(recordId), { body: { reviewStatus: 'done' }, headers: { 'x-frontline-csrf': 'wrong' } })).status).toBe(403);
    expect((await stateOf(who.owner.scopeId)).outcomes[demoId][0].reviewStatus).toBe('needs_review');
  });

  it('writes a recap once for a finished call, stores it, and serves it again without the model', async () => {
    const who = await newOwner();
    const demoId = (await startTest(who)).body.demoId;
    await workerWrites(who.owner.scopeId, callerTurn(demoId, 'I need my storefront walkway washed.', secondsAfterStart(5).toISOString()));
    const actor = { scopeId: who.owner.scopeId, stableAgentId: who.owner.agentId };
    let calls = 0;
    const writeRecap = async (transcript, { name }) => { calls += 1; return `${name} heard ${transcript.length} turn about a walkway wash.`; };
    const read = () => getConversation({ db, actor, conversationId: demoId, writeRecap, now: clock });
    // A call that is still running has no recap yet.
    expect((await read()).recap).toBeNull();
    expect(calls).toBe(0);
    await terminal({ scopeId: who.owner.scopeId, demoId });
    const first = await read();
    expect(first).toMatchObject({ recap: 'Blake heard 1 turn about a walkway wash.', requestLeftOpen: false });
    expect((await read()).recap).toBe('Blake heard 1 turn about a walkway wash.');
    expect(calls).toBe(1);
    expect((await stateOf(who.owner.scopeId)).recaps[demoId]).toMatchObject({ text: 'Blake heard 1 turn about a walkway wash.', entryCount: 1 });
    // Through the route, without a model configured, the stored recap is still shown.
    expect((await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`))).body.recap).toBe('Blake heard 1 turn about a walkway wash.');
  });

  it('prepares recaps ahead for the newest finished calls only', async () => {
    const who = await newOwner();
    const running = (await startTest(who)).body.demoId;
    await workerWrites(who.owner.scopeId, callerTurn(running, 'Do you wash decks?', secondsAfterStart(5).toISOString()));
    await terminal({ scopeId: who.owner.scopeId, demoId: running });
    const actor = { scopeId: who.owner.scopeId, stableAgentId: who.owner.agentId };
    const written = [];
    const writeRecap = async (transcript) => { written.push(transcript[0].text); return 'They asked whether decks are washed.'; };
    await prepareRecaps({ db, actor, writeRecap, now: clock, conversations: [{ conversationId: running, state: 'ended' }, { conversationId: randomUUID(), state: 'active' }] });
    expect(written).toEqual(['Do you wash decks?']);
    expect((await stateOf(who.owner.scopeId)).recaps[running].text).toBe('They asked whether decks are washed.');
  });

  it('still shows a finished call when the recap model fails, and flags a request left open', async () => {
    const who = await newOwner();
    const demoId = (await startTest(who)).body.demoId;
    await workerWrites(who.owner.scopeId, (state) => {
      callerTurn(demoId, 'I need a driveway wash.', secondsAfterStart(5).toISOString())(state);
      (state.workflows ??= {})[demoId] = { workflowInstanceId: randomUUID(), priorTasks: {}, currentTask: { kind: 'service_request', status: 'stopped', noteRecordId: 'n1', fields: { serviceNeed: 'Driveway washing' } } };
    });
    await terminal({ scopeId: who.owner.scopeId, demoId });
    const detail = await getConversation({ db, actor: { scopeId: who.owner.scopeId, stableAgentId: who.owner.agentId }, conversationId: demoId,
      writeRecap: async () => { throw new Error('call_recap_unavailable'); }, now: clock });
    expect(detail).toMatchObject({ recap: null, requestLeftOpen: true, transcript: [{ speaker: 'caller', text: 'I need a driveway wash.' }] });
    expect((await stateOf(who.owner.scopeId)).recaps?.[demoId]).toBeUndefined();
    const listed = (await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations`))).body.conversations;
    expect(listed.find((item) => item.conversationId === demoId).requestLeftOpen).toBe(true);
  });

  it('returns 410 once a conversation is past its retention date, and lists nothing for it', async () => {
    const who = await newOwner();
    const started = await startTest(who);
    clock = new Date(T0.getTime() + 31 * 86_400_000);
    expect((await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${started.body.demoId}`)).status).toBe(410);
    expect((await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations`))).body.conversations).toEqual([]);
    clock = T0;
  });
});

describe('Blake turns from the worker', () => {
  const turn = (extra = {}) => ({ clientTurnId: randomUUID(), text: 'We are open until five.', interrupted: false, expectedStateRevision: 1, ...extra });
  async function activeTest() {
    const who = await newOwner();
    const started = await startTest(who);
    scopeOfWorker = who.owner.scopeId;
    return { who, demoId: started.body.demoId, path: `/v1/internal/demos/${started.body.demoId}/assistant-turns` };
  }

  it('records Blake after the caller, marks a cut-off reply, and shows the two-sided transcript', async () => {
    const { who, demoId, path } = await activeTest();
    await workerWrites(who.owner.scopeId, callerTurn(demoId, 'When do you close?', secondsAfterStart(1).toISOString()));
    clock = secondsAfterStart(2);
    expect(await bearerPost(path, turn())).toMatchObject({ status: 201, body: { seq: 1 } });
    clock = secondsAfterStart(3);
    expect((await bearerPost(path, turn({ text: 'Our hours are', interrupted: true }))).body.seq).toBe(2);
    const detail = (await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`))).body;
    expect(detail.transcript.map((entry) => [entry.seq, entry.speaker, entry.interrupted ?? false])).toEqual([[1, 'caller', false], [2, 'bob', false], [3, 'bob', true]]);
    expect(detail.transcriptNotice).toBeNull();
    expect((await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations`))).body.conversations[0].hasBobTranscript).toBe(true);
    clock = T0;
  });

  it('is idempotent on clientTurnId', async () => {
    const { path } = await activeTest();
    const body = turn();
    const first = await bearerPost(path, body);
    expect(await bearerPost(path, body)).toMatchObject({ status: 201, body: { seq: first.body.seq, replayed: true } });
  });

  it.each([
    ['empty text', { text: '' }, 400], ['text over 2,000 characters', { text: 'x'.repeat(2001) }, 413], ['a bad turn id', { clientTurnId: 'nope' }, 400],
    ['a non-boolean interrupted', { interrupted: 'no' }, 400], ['a stale state revision', { expectedStateRevision: 9 }, 409],
  ])('rejects %s', async (_label, extra, status) => {
    const { path } = await activeTest();
    expect((await bearerPost(path, turn(extra))).status).toBe(status);
  });

  it('stops recording after the call ends, at 200 turns, and without the worker credential', async () => {
    const { who, demoId, path } = await activeTest();
    expect((await bearerPost(path, turn(), 'wrong')).status).toBe(404);
    await workerWrites(who.owner.scopeId, (state) => { state.transcripts = { [demoId]: Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, speaker: 'bob', text: 'x', at: T0.toISOString(), turnId: randomUUID() })) }; });
    expect(await bearerPost(path, turn())).toMatchObject({ status: 409, body: { title: 'transcript_full' } });
    expect((await json(await who.client.request('GET', `/v1/agents/${who.owner.agentId}/conversations/${demoId}`))).body.transcriptNotice).toBe('partial');
    const second = await activeTest();
    await terminal({ scopeId: second.who.owner.scopeId, demoId: second.demoId });
    expect(await bearerPost(second.path, turn())).toMatchObject({ status: 409, body: { title: 'session_ending' } });
  });
});
