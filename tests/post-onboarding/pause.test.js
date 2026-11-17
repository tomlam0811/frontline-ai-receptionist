import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { fromPglite, inOwnerScope } from '../../server/api/post-onboarding/database.js';
import { readDemo, updateDemo } from '../../server/api/post-onboarding/demo-store.js';
import { hasSelectedKnowledge, isPaused, lineageStatus, readLineage, receptionistNameFor } from '../../server/api/post-onboarding/lineage.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner, startServer } from './fixtures.js';

// MR-D5, MR-D10 (Resume guard), MR-J4: pause and resume one receptionist. Acceptance MR-T7 and MR-T8.
// The database, handler and share and guest logic are real. Only the paid voice provider is faked.

let pg; let db; let app; let voice; let ended;
const tokenOf = (url) => new URL(url).hash.replace('#t=', '');
const json = async (response) => ({ status: response.status, body: await response.json() });
const ownerSql = (sql, params) => asOwner(pg, () => pg.query(sql, params));
const stateOf = (scopeId) => asOwner(pg, async () => (await pg.query('SELECT state, version FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId])).rows[0]);
const grantRow = (id) => asOwner(pg, async () => (await pg.query('SELECT * FROM frontline_share_grants WHERE id = $1', [id])).rows[0]);

/** What the real terminal path does to the reservation and the demo (connection PO-C1 supplies the real one). */
async function terminal({ scopeId, demoId, reason }) {
  ended.push({ scopeId, demoId, reason });
  const demo = await readDemo(db, scopeId, demoId);
  await inOwnerScope(db, scopeId, (tx) => tx.query("SELECT settle_voice_start($1::uuid,'completed')", [demo.reservationId]));
  await updateDemo(db, scopeId, demoId, () => ({ state: 'ended', endedAt: new Date().toISOString(), terminalReason: 'caller_ended', voiceCleanupCompleted: true }));
  return { demoId, state: 'ended' };
}

async function newOwner() {
  const owner = await seedClaimedOwner(pg, { researched: true });
  await pg.exec('SET ROLE frontline_app');
  return { owner, client: browserClient(app, owner.authToken), agent: `/v1/agents/${owner.agentId}` };
}
const pause = (who) => who.client.request('POST', `${who.agent}/pause`, { body: {} });
const resume = (who) => who.client.request('POST', `${who.agent}/resume`, { body: {} });
const createLink = (who) => who.client.request('POST', `${who.agent}/shares`, { body: { expectedAgentVersionId: who.owner.agentId } });
const startTest = (who) => who.client.request('POST', `${who.agent}/tests`, { body: { expectedAgentVersionId: who.owner.agentId } });
/** @param {string} path @param {{method?: string, cookie?: string, body?: unknown}} [options] */
const guestCall = (path, { method = 'POST', cookie, body } = {}) => app.fetch(`${app.baseUrl}${path}`, {
  method, headers: { origin: app.baseUrl, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : { 'x-frontline-guest': '1' }) }, body: body ? JSON.stringify(body) : undefined,
});
async function openLink(url) {
  const response = await guestCall('/v1/shared/exchange', { body: { token: tokenOf(url) } });
  return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}
/** Writes lineage fields straight into the scope JSON, the way the naming and knowledge tickets will. */
async function patchLineage(who, patch) {
  const { state } = await stateOf(who.owner.scopeId);
  const lineage = readLineage(state, who.owner.agentId);
  const next = { ...state, agentLineages: { ...state.agentLineages, [who.owner.agentId]: { ...lineage, ...patch } } };
  await ownerSql('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1 WHERE owner_scope_id = $1', [who.owner.scopeId, JSON.stringify(next)]);
}
const lineageOf = async (who) => readLineage((await stateOf(who.owner.scopeId)).state, who.owner.agentId);

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = fromPglite(pg);
  await pg.exec('SET ROLE frontline_app');
  voice = fakeVoice(); ended = [];
  app = startServer(pg, {
    voice, endLiveCall: terminal, endOwnerDemo: terminal, endGuestDemo: terminal, limits: { ownerWrite: 10_000, ownerRead: 10_000, guest: 10_000 },
    guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 1_000_000, reservedCents: 100, globalConcurrent: 500 },
  });
});
afterAll(async () => { await app?.close(); });

describe('status helpers', () => {
  it('reads a lineage with no stored status as active', () => {
    expect(lineageStatus({})).toBe('active');
    expect(lineageStatus({ status: 'paused' })).toBe('paused');
    expect(isPaused({ status: 'paused' })).toBe(true);
    expect(isPaused({})).toBe(false);
  });
  it('names the receptionist from the lineage and falls back to Blake', () => {
    expect(receptionistNameFor({})).toBe('Blake');
    expect(receptionistNameFor(null)).toBe('Blake');
    expect(receptionistNameFor({ name: 'Ava' })).toBe('Ava');
  });
  it('treats a lineage without sourceIds as using all knowledge, and an empty selection as none', () => {
    expect(hasSelectedKnowledge({}, {})).toBe(true);
    expect(hasSelectedKnowledge({}, { sourceIds: undefined })).toBe(true);
    expect(hasSelectedKnowledge({}, { sourceIds: ['src-1'] })).toBe(true);
    expect(hasSelectedKnowledge({}, { sourceIds: [] })).toBe(false);
  });
});

describe('MR-T7 a paused receptionist takes no new calls or links', () => {
  it('rejects an owner test start and a share create with the paused reason', async () => {
    const who = await newOwner();
    expect((await json(await pause(who))).body).toMatchObject({ stableAgentId: who.owner.agentId, status: 'paused' });
    const test = await json(await startTest(who));
    expect([test.status, test.body.title, test.body.detail]).toEqual([409, 'agent_paused', 'Blake is paused.']);
    const share = await json(await createLink(who));
    expect([share.status, share.body.title, share.body.detail]).toEqual([409, 'agent_paused', 'Blake is paused.']);
    expect(Number((await ownerSql('SELECT count(*) AS n FROM voice_start_reservations WHERE owner_scope_id = $1', [who.owner.scopeId])).rows[0].n)).toBe(0);
    expect((await json(await who.client.request('GET', `${who.agent}/shares`))).body.shares).toEqual([]);
  });

  it('names the receptionist in the reason', async () => {
    const who = await newOwner();
    await patchLineage(who, { name: 'Ava' });
    await pause(who);
    expect((await json(await startTest(who))).body.detail).toBe('Ava is paused.');
  });

  it('rejects guest exchange and guest start when the status is paused, and leaves the link unused', async () => {
    const who = await newOwner();
    const share = (await json(await createLink(who))).body;
    const { cookie } = await openLink(share.url);
    // Simulates a start that races the pause: the status is set but the link was not revoked yet.
    await patchLineage(who, { status: 'paused' });
    const start = await json(await guestCall('/v1/shared/start', { cookie }));
    expect([start.status, start.body.title, start.body.reason]).toEqual([404, 'link_unavailable', 'unavailable']);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'unused', lease_generation: 0, demo_id: null });
    expect(Number((await ownerSql('SELECT count(*) AS n FROM voice_start_reservations WHERE owner_scope_id = $1', [who.owner.scopeId])).rows[0].n)).toBe(0);
    const startedBefore = voice.started.length;
    const reopened = await json(await guestCall('/v1/shared/exchange', { body: { token: tokenOf(share.url) } }));
    expect([reopened.status, reopened.body.title, reopened.body.reason]).toEqual([404, 'link_unavailable', 'unavailable']);
    expect(voice.started).toHaveLength(startedBefore);
  });

  it('shows a guest who opens a link of a paused receptionist the revoked state', async () => {
    const who = await newOwner();
    const share = (await json(await createLink(who))).body;
    await pause(who);
    const reopened = await json(await guestCall('/v1/shared/exchange', { body: { token: tokenOf(share.url) } }));
    expect([reopened.status, reopened.body.title, reopened.body.reason]).toEqual([404, 'link_unavailable', 'revoked']);
  });

  it('still lists and opens its conversations', async () => {
    const who = await newOwner();
    const test = (await json(await startTest(who))).body;
    await terminal({ scopeId: who.owner.scopeId, demoId: test.demoId, reason: 'caller_ended' });
    await pause(who);
    const list = await json(await who.client.request('GET', `${who.agent}/conversations`));
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((item) => item.conversationId)).toContain(test.demoId);
    expect((await who.client.request('GET', `${who.agent}/conversations/${test.demoId}`)).status).toBe(200);
  });

  it('starts again after Resume', async () => {
    const who = await newOwner();
    await pause(who);
    expect((await json(await resume(who))).body).toMatchObject({ status: 'active' });
    expect((await startTest(who)).status).toBe(201);
    expect((await createLink(who)).status).toBe(201);
  });
});

describe('MR-T8 pause revokes links and ends live calls, and resume does not restore links', () => {
  it('revokes every unused link, and Resume leaves them revoked', async () => {
    const who = await newOwner();
    const links = [(await json(await createLink(who))).body, (await json(await createLink(who))).body, (await json(await createLink(who))).body];
    const paused = await json(await pause(who));
    expect(paused.body).toMatchObject({ status: 'paused', linksRevoked: 3 });
    for (const link of links) expect(await grantRow(link.shareId)).toMatchObject({ status: 'revoked' });
    await resume(who);
    for (const link of links) expect(await grantRow(link.shareId)).toMatchObject({ status: 'revoked' });
    const listed = (await json(await who.client.request('GET', `${who.agent}/shares`))).body.shares;
    expect(listed.map((share) => share.status)).toEqual(['revoked', 'revoked', 'revoked']);
    const reopened = await json(await guestCall('/v1/shared/exchange', { body: { token: tokenOf(links[0].url) } }));
    expect(reopened.body.reason).toBe('revoked');
    const fresh = await json(await createLink(who));
    expect(fresh.status).toBe(201);
    expect(await grantRow(fresh.body.shareId)).toMatchObject({ status: 'unused' });
  });

  it('keeps a link that already finished its conversation as it was', async () => {
    const who = await newOwner();
    const share = (await json(await createLink(who))).body;
    const { cookie } = await openLink(share.url);
    const credentials = (await json(await guestCall('/v1/shared/start', { cookie }))).body;
    await terminal({ scopeId: who.owner.scopeId, demoId: credentials.demoId, reason: 'caller_ended' });
    await ownerSql("UPDATE frontline_share_grants SET status = 'consumed', consumed_at = now() WHERE id = $1", [share.shareId]);
    expect((await json(await pause(who))).body.linksRevoked).toBe(0);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'consumed' });
  });

  it('ends a live shared conversation through the ended-early handling', async () => {
    const who = await newOwner();
    const share = (await json(await createLink(who))).body;
    const { cookie } = await openLink(share.url);
    const credentials = (await json(await guestCall('/v1/shared/start', { cookie }))).body;
    ended.length = 0;
    expect((await pause(who)).status).toBe(200);
    expect(ended).toEqual([expect.objectContaining({ scopeId: who.owner.scopeId, demoId: credentials.demoId })]);
    expect((await readDemo(db, who.owner.scopeId, credentials.demoId)).state).toBe('ended');
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'revoked' });
    expect((await guestCall('/v1/shared/session', { method: 'GET', cookie })).status).toBe(401);
  });

  it('ends a live owner test call', async () => {
    const who = await newOwner();
    const test = (await json(await startTest(who))).body;
    ended.length = 0;
    expect((await pause(who)).status).toBe(200);
    expect(ended).toEqual([{ scopeId: who.owner.scopeId, demoId: test.demoId, reason: 'agent_paused' }]);
    expect((await readDemo(db, who.owner.scopeId, test.demoId)).state).toBe('ended');
  });

  it('does not touch another receptionist in the same business or another owner', async () => {
    const who = await newOwner();
    const other = await newOwner();
    const otherLink = (await json(await createLink(other))).body;
    const otherTest = (await json(await startTest(other))).body;
    await pause(who);
    expect(await grantRow(otherLink.shareId)).toMatchObject({ status: 'unused' });
    expect((await readDemo(db, other.owner.scopeId, otherTest.demoId)).state).not.toBe('ended');
  });
});

describe('who may pause', () => {
  it('answers 404 for another owner and changes nothing', async () => {
    const who = await newOwner();
    const intruder = await newOwner();
    const link = (await json(await createLink(who))).body;
    const attempt = await intruder.client.request('POST', `${who.agent}/pause`, { body: {} });
    expect(attempt.status).toBe(404);
    expect((await intruder.client.request('POST', `${who.agent}/resume`, { body: {} })).status).toBe(404);
    expect(lineageStatus(await lineageOf(who))).toBe('active');
    expect(await grantRow(link.shareId)).toMatchObject({ status: 'unused' });
  });

  it('needs a sign-in and the CSRF pair, and refuses a body with fields', async () => {
    const who = await newOwner();
    expect((await browserClient(app, null).request('POST', `${who.agent}/pause`, { body: {} })).status).toBe(404);
    const noCsrf = await app.fetch(`${app.baseUrl}${who.agent}/pause`, { method: 'POST', headers: { origin: app.baseUrl, cookie: `fl_auth=${who.owner.authToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    const withField = await json(await who.client.request('POST', `${who.agent}/pause`, { body: { status: 'paused' } }));
    expect([withField.status, withField.body.title]).toEqual([400, 'invalid_field']);
    expect(lineageStatus(await lineageOf(who))).toBe('active');
  });

  it('is limited by the owner write budget', async () => {
    const limited = startServer(pg, { voice, limits: { ownerWrite: 2, ownerRead: 100 } });
    const who = await newOwner();
    const client = browserClient(limited, who.owner.authToken);
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await client.request('POST', `${who.agent}/pause`, { body: {} })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('repeating pause and resume', () => {
  it('pausing twice changes nothing the second time', async () => {
    const who = await newOwner();
    await pause(who);
    const before = await stateOf(who.owner.scopeId);
    const again = await json(await pause(who));
    expect(again).toMatchObject({ status: 200, body: { status: 'paused', linksRevoked: 0 } });
    expect((await stateOf(who.owner.scopeId)).version).toBe(before.version);
  });

  it('a repeated pause finishes cleanup the first request left undone', async () => {
    const who = await newOwner();
    await patchLineage(who, { status: 'paused' });
    const link = (await json(await createLinkDirect(who))).body;
    expect(await grantRow(link.shareId)).toMatchObject({ status: 'unused' });
    expect((await json(await pause(who))).body.linksRevoked).toBe(1);
    expect(await grantRow(link.shareId)).toMatchObject({ status: 'revoked' });
  });

  it('resuming an active receptionist changes nothing', async () => {
    const who = await newOwner();
    const before = await stateOf(who.owner.scopeId);
    expect(await json(await resume(who))).toMatchObject({ status: 200, body: { status: 'active' } });
    await pause(who);
    await resume(who);
    const settled = await stateOf(who.owner.scopeId);
    expect(await json(await resume(who))).toMatchObject({ status: 200, body: { status: 'active' } });
    expect((await stateOf(who.owner.scopeId)).version).toBe(settled.version);
    expect(settled.version).toBeGreaterThan(before.version);
  });

  it('keeps the receptionist version and name when the status changes', async () => {
    const who = await newOwner();
    await patchLineage(who, { name: 'Ava' });
    await pause(who);
    await resume(who);
    const lineage = await lineageOf(who);
    expect(lineage).toMatchObject({ name: 'Ava', status: 'active', currentAgentVersionId: who.owner.agentId, pointerGeneration: 1 });
  });
});

/** Creates a link with no pause check, as a link that existed before the status flip. */
async function createLinkDirect(who) {
  await patchLineage(who, { status: 'active' });
  const created = await createLink(who);
  await patchLineage(who, { status: 'paused' });
  return created;
}

describe('MR-D10 Resume needs selected knowledge', () => {
  it('refuses to resume with an empty selection and resumes once one source is selected', async () => {
    const who = await newOwner();
    await patchLineage(who, { name: 'Ava', sourceIds: [] });
    await pause(who);
    const refused = await json(await resume(who));
    expect([refused.status, refused.body.title, refused.body.detail]).toEqual([409, 'needs_knowledge', 'Ava needs knowledge before it can take calls. Choose at least one source.']);
    expect(lineageStatus(await lineageOf(who))).toBe('paused');
    await patchLineage(who, { sourceIds: ['src-1'] });
    expect((await json(await resume(who))).body.status).toBe('active');
  });

  it('resumes a receptionist whose lineage has no selection yet', async () => {
    const who = await newOwner();
    await pause(who);
    expect((await resume(who)).status).toBe(200);
  });
});

describe('owner summaries carry the status', () => {
  it('shows active, then paused, then active in the list and the summary', async () => {
    const who = await newOwner();
    const read = async () => ({
      summary: (await json(await who.client.request('GET', `${who.agent}/summary`))).body.status,
      list: (await json(await who.client.request('GET', '/v1/me/agents'))).body.agents.find((agent) => agent.stableAgentId === who.owner.agentId).status,
    });
    expect(await read()).toEqual({ summary: 'active', list: 'active' });
    await pause(who);
    expect(await read()).toEqual({ summary: 'paused', list: 'paused' });
    await resume(who);
    expect(await read()).toEqual({ summary: 'active', list: 'active' });
  });
});
