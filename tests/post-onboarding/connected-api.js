import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { createApiHandler } from '../../server/api/service.js';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createPaidStartGate } from '../../server/api/paid-start-gate.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner } from './fixtures.js';

// The existing createApiHandler with the post-onboarding routes connected, over the real PostgresStore code and the
// real migrations on an in-process Postgres. Only the paid LiveKit provider is faked. Connection tests share this setup.
export const SERVICE_TOKEN = 'test-service-token-0123456789-abcdefghij';
export const BASE_URL = 'http://frontline.test';
const GATE_ENV = { FRONTLINE_VOICE_SPEND_CAP_USD: '10', FRONTLINE_VOICE_MAX_SESSION_USD: '1', FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX: '3' };
const guestHeaders = { origin: BASE_URL, 'x-frontline-guest': '1' };

/** Serves an API handler without a network socket, in the shape the browser client helpers expect. */
export function serveApi(api) {
  return {
    baseUrl: BASE_URL,
    /** @param {string} input @param {{method?: string, headers?: Record<string, string>, body?: string}} [init] */
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

/** @param {{researched?: boolean, apiOptions?: Record<string, unknown> | ((store: any) => Record<string, unknown>)}} [options] */
export async function startConnectedApi({ researched = true, apiOptions = {} } = {}) {
  const saved = { token: process.env.FRONTLINE_VOICE_SERVICE_TOKEN, flag: process.env.FRONTLINE_POST_ONBOARDING, base: process.env.APP_BASE_URL };
  process.env.FRONTLINE_VOICE_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.APP_BASE_URL = BASE_URL;
  process.env.FRONTLINE_POST_ONBOARDING = 'on';
  const pg = await createMigratedDatabase();
  const owner = await seedClaimedOwner(pg, { researched });
  await pg.exec('SET ROLE frontline_app');
  const voice = Object.assign(fakeVoice(), { isReady: async () => true, watchdogHealthy: () => true });
  const store = Object.create(PostgresStore.prototype);
  store.ensureReady = async () => {};
  store.pool = { query: (sql, params) => pg.query(sql, params), connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };
  const extraOptions = typeof apiOptions === 'function' ? apiOptions(store) : apiOptions;
  const api = createApiHandler({
    store, voiceAdapter: voice, paidStartGate: createPaidStartGate(store, GATE_ENV), enablePaidVoiceStarts: true,
    prepareBusiness: async () => ({}), preparationQueue: { start() {}, stop() {}, healthy: () => true },
    postOnboarding: { limits: { ownerWrite: 10_000, ownerRead: 10_000, guest: 10_000 } }, ...extraOptions,
  });
  const app = serveApi(api);
  const ownerClient = browserClient(app, owner.authToken);
  const ownerSql = (sql, params) => asOwner(pg, () => pg.query(sql, params));
  const demoRecord = async (demoId) => (await ownerSql("SELECT state->'demos'->$2::text AS demo FROM scoped_workspace_states WHERE owner_scope_id = $1", [owner.scopeId, demoId])).rows[0].demo;

  /** A call from the voice worker for one demo, with the room, generation and agent binding the service checks. */
  /** @param {any} demo @param {string} action @param {unknown} [body] @param {Record<string, string>} [override] @param {string} [method] */
  const workerCall = (demo, action, body = {}, override = {}, method = 'POST') => app.fetch(`${BASE_URL}/v1/internal/demos/${demo.id}/${action}`, {
    method, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${SERVICE_TOKEN}`, 'x-frontline-room': demo.roomName, 'x-frontline-generation': String(demo.generation), 'x-frontline-agent-version-id': demo.agentVersionId, ...override },
  });
  const startOwnerTest = async (versionId = owner.agentId) => {
    const started = await ownerClient.request('POST', `/v1/agents/${owner.agentId}/tests`, { body: { expectedAgentVersionId: versionId } });
    expect(started.status).toBe(201);
    return demoRecord((await started.json()).demoId);
  };
  const guestPost = (path, cookie) => app.fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { ...guestHeaders, cookie } });
  const startGuestCall = async () => {
    const share = await (await ownerClient.request('POST', `/v1/agents/${owner.agentId}/shares`, { body: { expectedAgentVersionId: (await (await ownerClient.request('GET', `/v1/agents/${owner.agentId}/summary`)).json()).currentAgentVersionId } })).json();
    const opened = await app.fetch(`${BASE_URL}/v1/shared/exchange`, { method: 'POST', headers: { ...guestHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(share.url).hash.replace('#t=', '') }) });
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];
    const started = await guestPost('/v1/shared/start', cookie);
    expect(started.status).toBe(201);
    return { share, cookie, demo: await demoRecord((await started.json()).demoId) };
  };
  const restore = () => {
    for (const [name, value] of [['FRONTLINE_VOICE_SERVICE_TOKEN', saved.token], ['FRONTLINE_POST_ONBOARDING', saved.flag], ['APP_BASE_URL', saved.base]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
  return { pg, store, api, app, voice, owner, ownerClient, ownerSql, demoRecord, workerCall, startOwnerTest, startGuestCall, guestPost, restore };
}
