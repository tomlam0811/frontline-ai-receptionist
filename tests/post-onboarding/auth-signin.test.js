import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiHandler } from '../../server/api/service.js';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createPaidStartGate } from '../../server/api/paid-start-gate.js';
import { createMigratedDatabase } from './database.js';
import { browserClient, fakeVoice, seedClaimedOwner } from './fixtures.js';

// The landing page's "Sign in" link, with no claimed resource in hand yet (unlike /auth/google/start, which
// needs a completed demo's claim intent, and /auth/google/reauth, which needs a known resource id).
const SERVICE_TOKEN = 'test-service-token-0123456789-abcdefghij';
const ENV = { FRONTLINE_VOICE_SPEND_CAP_USD: '10', FRONTLINE_VOICE_MAX_SESSION_USD: '1', FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX: '3' };
const BASE_URL = 'http://frontline.test';

let pg; let voice; let store; let saved;

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

function buildApp(authClaims) {
  const api = createApiHandler({
    authClaims, store, voiceAdapter: voice, paidStartGate: createPaidStartGate(store, ENV), enablePaidVoiceStarts: true,
    prepareBusiness: async () => ({}), preparationQueue: { start() {}, stop() {}, healthy: () => true },
    postOnboarding: { limits: { ownerWrite: 10_000, ownerRead: 10_000, guest: 10_000 } },
  });
  return browserClient(serveApi(api), null);
}

beforeEach(async () => {
  saved = { token: process.env.FRONTLINE_VOICE_SERVICE_TOKEN, flag: process.env.FRONTLINE_POST_ONBOARDING, base: process.env.APP_BASE_URL };
  process.env.FRONTLINE_VOICE_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.APP_BASE_URL = BASE_URL;
  process.env.FRONTLINE_POST_ONBOARDING = 'on';
  pg = await createMigratedDatabase();
  await seedClaimedOwner(pg, { researched: true });
  await pg.exec('SET ROLE frontline_app');
  voice = Object.assign(fakeVoice(), { isReady: async () => true, watchdogHealthy: () => true });
  store = Object.create(PostgresStore.prototype);
  store.ensureReady = async () => {};
  store.pool = { query: (sql, params) => pg.query(sql, params), connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };
});
afterEach(() => {
  for (const [name, value] of [['FRONTLINE_VOICE_SERVICE_TOKEN', saved.token], ['FRONTLINE_POST_ONBOARDING', saved.flag], ['APP_BASE_URL', saved.base]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe('POST /v1/auth/google/signin', () => {
  it('starts Google sign-in with no resource id or claim intent required', async () => {
    const client = buildApp({ googleConfigured: () => true, startGoogle: () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', setCookies: ['fl_google_state=abc; Path=/'] }) });
    const response = await client.request('POST', '/v1/auth/google/signin', { body: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    expect(response.headers.get('set-cookie')).toContain('fl_google_state=abc');
  });

  it('is unavailable when Google sign-in is not configured, matching the other auth-start routes', async () => {
    const client = buildApp({ googleConfigured: () => false });
    const response = await client.request('POST', '/v1/auth/google/signin', { body: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'identity_unavailable' });
  });
});
