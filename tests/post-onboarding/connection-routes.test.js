import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiHandler } from '../../server/api/service.js';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createPaidStartGate } from '../../server/api/paid-start-gate.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner } from './fixtures.js';
import { callerSays } from './ui-calls.js';

// PO-C14 and PO-C19: the post-onboarding handler mounted in the existing createApiHandler, with the worker credential,
// the owner and guest end paths and the owner test completion wired to the existing terminal path. Real handler, real
// PostgresStore code and real migrations on an in-process Postgres. Only the paid LiveKit provider is faked.
const SERVICE_TOKEN = 'test-service-token-0123456789-abcdefghij';
const ENV = { FRONTLINE_VOICE_SPEND_CAP_USD: '10', FRONTLINE_VOICE_MAX_SESSION_USD: '1', FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX: '3' };
const BASE_URL = 'http://frontline.test';

let pg; let voice; let store; let app; let owner; let ownerClient; let saved;
const ownerSql = (sql, params) => asOwner(pg, () => pg.query(sql, params));
const demoRecord = async (demoId) => (await ownerSql("SELECT state->'demos'->$2::text AS demo FROM scoped_workspace_states WHERE owner_scope_id = $1", [owner.scopeId, demoId])).rows[0].demo;
const grantRow = async (id) => (await ownerSql('SELECT * FROM frontline_share_grants WHERE id = $1', [id])).rows[0];
const reservationState = async (id) => (await ownerSql('SELECT state FROM voice_start_reservations WHERE id = $1', [id])).rows[0].state;

/** Serves the existing API handler without a network socket, in the shape the browser client helpers expect. */
function serveApi(api) {
  return {
    baseUrl: BASE_URL,
    async fetch(input, init = {}) {
      const url = new URL(String(input), BASE_URL);
      const body = init.body == null ? [] : [Buffer.from(init.body)];
      const headers = Object.fromEntries(Object.entries({ host: url.host, ...(init.headers ?? {}) }).map(([key, value]) => [key.toLowerCase(), String(value)]));
      const request = Object.assign(Readable.from(body), { method: init.method ?? 'GET', headers, url: url.pathname + url.search, socket: { remoteAddress: '127.0.0.1' } });
      let status; let responseHeaders; const chunks = [];
      await new Promise((resolve) => {
        const response = { headersSent: false, writeHead(code, hdrs) { status = code; responseHeaders = hdrs; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve(undefined); }, destroy() { resolve(undefined); } };
        Promise.resolve(api(request, response, url)).catch(resolve);
      });
      return new Response(Buffer.concat(chunks), { status, headers: responseHeaders });
    },
  };
}

/** A call from the voice worker for one demo, with the room, generation and agent binding the service checks. */
/** @param {any} demo @param {string} action @param {unknown} [body] @param {Record<string, string>} [override] */
const workerCall = (demo, action, body = {}, override = {}) => app.fetch(`${BASE_URL}/v1/internal/demos/${demo.id}/${action}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}`, 'x-frontline-room': demo.roomName, 'x-frontline-generation': String(demo.generation), 'x-frontline-agent-version-id': demo.agentVersionId, ...override },
});

const guestHeaders = { origin: BASE_URL, 'x-frontline-guest': '1' };
async function startGuestCall() {
  const created = await (await ownerClient.request('POST', `/v1/agents/${owner.agentId}/shares`, { body: { expectedAgentVersionId: owner.agentId } })).json();
  const opened = await app.fetch(`${BASE_URL}/v1/shared/exchange`, { method: 'POST', headers: { ...guestHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(created.url).hash.replace('#t=', '') }) });
  const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];
  const started = await app.fetch(`${BASE_URL}/v1/shared/start`, { method: 'POST', headers: { ...guestHeaders, cookie } });
  expect(started.status).toBe(201);
  return { share: created, cookie, demo: await demoRecord((await started.json()).demoId) };
}
const guestPost = (path, cookie) => app.fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { ...guestHeaders, cookie } });

async function startOwnerTest() {
  const started = await ownerClient.request('POST', `/v1/agents/${owner.agentId}/tests`, { body: { expectedAgentVersionId: owner.agentId } });
  expect(started.status).toBe(201);
  return { demoId: (await started.json()).demoId };
}

beforeEach(async () => {
  saved = { token: process.env.FRONTLINE_VOICE_SERVICE_TOKEN, flag: process.env.FRONTLINE_POST_ONBOARDING, base: process.env.APP_BASE_URL };
  process.env.FRONTLINE_VOICE_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.APP_BASE_URL = BASE_URL;
  process.env.FRONTLINE_POST_ONBOARDING = 'on';
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg, { researched: true });
  await pg.exec('SET ROLE frontline_app');
  voice = Object.assign(fakeVoice(), { isReady: async () => true, watchdogHealthy: () => true });
  store = Object.create(PostgresStore.prototype);
  store.ensureReady = async () => {};
  store.pool = { query: (sql, params) => pg.query(sql, params), connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };
  const api = createApiHandler({
    store, voiceAdapter: voice, paidStartGate: createPaidStartGate(store, ENV), enablePaidVoiceStarts: true,
    prepareBusiness: async () => ({}), preparationQueue: { start() {}, stop() {}, healthy: () => true },
    postOnboarding: { limits: { ownerWrite: 10_000, ownerRead: 10_000, guest: 10_000 } },
  });
  app = serveApi(api);
  ownerClient = browserClient(app, owner.authToken);
});
afterEach(() => {
  for (const [name, value] of [['FRONTLINE_VOICE_SERVICE_TOKEN', saved.token], ['FRONTLINE_POST_ONBOARDING', saved.flag], ['APP_BASE_URL', saved.base]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe('the handler chain (PO-C14)', () => {
  const ownedRequests = () => [
    ['GET', '/v1/me/agents'], ['POST', '/v1/shared/exchange'], ['GET', '/v1/builder/session'],
    ['GET', `/v1/agents/${owner.agentId}/summary`], ['POST', `/v1/internal/demos/${randomUUID()}/assistant-turns`],
  ];

  it('with the flag off every post-onboarding route is the original 404', async () => {
    delete process.env.FRONTLINE_POST_ONBOARDING;
    for (const [method, path] of ownedRequests()) {
      const response = await ownerClient.request(method, path, { body: method === 'POST' ? {} : undefined });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({ title: 'not_found', detail: 'API route not found.' });
    }
    process.env.FRONTLINE_POST_ONBOARDING = 'off';
    expect((await ownerClient.request('GET', '/v1/me/agents')).status).toBe(404);
  });

  it('with the flag on the routes answer, and the existing routes are unchanged', async () => {
    const home = await ownerClient.request('GET', '/v1/me/agents');
    expect(home.status).toBe(200);
    expect((await home.json()).agents).toHaveLength(1);
    expect((await ownerClient.request('GET', `/v1/agents/${owner.agentId}/summary`)).status).toBe(200);
    expect((await app.fetch(`${BASE_URL}/v1/session`, { headers: { origin: BASE_URL } })).status).toBe(200);
    const unknown = await ownerClient.request('GET', '/v1/nothing-here');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ detail: 'API route not found.' });
  });

  it('the flag is read on every request, so turning it off returns to the original behavior', async () => {
    expect((await ownerClient.request('GET', '/v1/me/agents')).status).toBe(200);
    delete process.env.FRONTLINE_POST_ONBOARDING;
    expect((await ownerClient.request('GET', '/v1/me/agents')).status).toBe(404);
  });
});

describe('the worker credential and the terminal path (PO-C19)', () => {
  it('lets the worker record Blake turns with its own credential and refuses a wrong binding', async () => {
    const { demoId } = await startOwnerTest();
    const demo = await demoRecord(demoId);
    const turn = () => ({ clientTurnId: randomUUID(), text: 'We open at nine.', interrupted: false, expectedStateRevision: 1 });
    expect((await workerCall(demo, 'assistant-turns', turn())).status).toBe(201);
    expect((await workerCall(demo, 'assistant-turns', turn(), { authorization: 'Bearer wrong-token-wrong-token-wrong-token-1' })).status).toBe(401);
    expect((await workerCall(demo, 'assistant-turns', turn(), { 'x-frontline-room': 'frontline-demo-other' })).status).toBe(403);
    expect((await workerCall(demo, 'assistant-turns', turn(), { 'x-frontline-generation': '2' })).status).toBe(403);
    // A browser session is not a worker credential.
    expect((await ownerClient.request('POST', `/v1/internal/demos/${demoId}/assistant-turns`, { body: turn() })).status).toBe(401);
  });

  it('counts an owner test as tested when the worker ends it after the owner spoke', async () => {
    const { demoId } = await startOwnerTest();
    const demo = await demoRecord(demoId);
    expect((await workerCall(demo, 'ready')).status).toBe(200);
    await callerSays(pg, owner.scopeId, demoId, 'What are your hours?');
    const before = await (await ownerClient.request('GET', `/v1/agents/${owner.agentId}/summary`)).json();
    expect(before.currentVersionTestedAt).toBeNull();
    const ending = await (await workerCall(demo, 'ending', { expectedStateRevision: 1, reason: 'caller_ended' })).json();
    expect((await workerCall(demo, 'terminal', { expectedStateRevision: ending.stateRevision, reason: 'caller_ended' })).status).toBe(200);
    const after = await (await ownerClient.request('GET', `/v1/agents/${owner.agentId}/summary`)).json();
    expect(after.currentVersionTestedAt).toEqual(expect.any(String));
    expect(voice.ended).toContain(demoId);
  });

  it('lets the owner end their own test call through the terminal path', async () => {
    const { demoId } = await startOwnerTest();
    const demo = await demoRecord(demoId);
    await workerCall(demo, 'ready');
    await callerSays(pg, owner.scopeId, demoId, 'Do you fix cracked teeth?');
    const ended = await ownerClient.request('POST', `/v1/agents/${owner.agentId}/tests/${demoId}/end`);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ demoId, state: 'ended' });
    expect(await demoRecord(demoId)).toMatchObject({ state: 'ended', terminalReason: 'caller_ended' });
    expect(voice.ended).toContain(demoId);
    expect(await reservationState(demo.reservationId)).toBe('completed');
    expect((await (await ownerClient.request('GET', `/v1/agents/${owner.agentId}/summary`)).json()).currentVersionTestedAt).toEqual(expect.any(String));
    // Ending twice is safe.
    expect((await ownerClient.request('POST', `/v1/agents/${owner.agentId}/tests/${demoId}/end`)).status).toBe(200);
  });

  it('does not end a call the worker is already closing', async () => {
    const { demoId } = await startOwnerTest();
    const demo = await demoRecord(demoId);
    await workerCall(demo, 'ready');
    await workerCall(demo, 'ending', { expectedStateRevision: 1, reason: 'urgency' });
    const response = await ownerClient.request('POST', `/v1/agents/${owner.agentId}/tests/${demoId}/end`);
    expect(await response.json()).toMatchObject({ state: 'ending' });
    expect((await demoRecord(demoId)).state).toBe('ending');
  });

  it('lets a guest end their conversation, consuming the link, and refuses a second one', async () => {
    const { share, cookie, demo } = await startGuestCall();
    await workerCall(demo, 'ready');
    expect((await grantRow(share.shareId)).status).toBe('active');
    const ended = await guestPost('/v1/shared/end', cookie);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ state: 'ended' });
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'consumed', terminal_reason: 'caller_ended' });
    expect(await reservationState(demo.reservationId)).toBe('completed');
    expect((await guestPost('/v1/shared/start', cookie)).status).toBe(409);
  });

  it('gives a link back when the guest leaves before the call started', async () => {
    const { share, cookie, demo } = await startGuestCall();
    expect((await guestPost('/v1/shared/end', cookie)).status).toBe(200);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'unused', demo_id: null });
    expect(await reservationState(demo.reservationId)).toBe('released');
    expect((await guestPost('/v1/shared/start', cookie)).status).toBe(201);
  });

  it('keeps paid starts closed until the adapter and the durable watchdog are healthy', async () => {
    voice.watchdogHealthy = () => false;
    const response = await ownerClient.request('POST', `/v1/agents/${owner.agentId}/tests`, { body: { expectedAgentVersionId: owner.agentId } });
    expect(response.status).toBe(503);
    expect(voice.started).toEqual([]);
  });
});
