import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiHandler } from '../../server/api/service.js';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createPaidStartGate } from '../../server/api/paid-start-gate.js';
import { createMigratedDatabase } from './database.js';
import { browserClient, fakeVoice, seedClaimedOwner } from './fixtures.js';

// PO-C14 and PO-C19: the post-onboarding handler mounted in the existing createApiHandler, with the worker credential,
// the owner and guest end paths and the owner test completion wired to the existing terminal path. Real handler, real
// PostgresStore code and real migrations on an in-process Postgres. Only the paid LiveKit provider is faked.
const SERVICE_TOKEN = 'test-service-token-0123456789-abcdefghij';
const ENV = { FRONTLINE_VOICE_SPEND_CAP_USD: '10', FRONTLINE_VOICE_MAX_SESSION_USD: '1', FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX: '3' };
const BASE_URL = 'http://frontline.test';

let pg; let voice; let store; let app; let owner; let ownerClient; let saved;
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
    authClaims: { isConfigured: () => true, googleConfigured: () => true },
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


// The API adds `version: '1.0'` (the schema version) to every response and overwrote the setup version, so the browser sent
// expectedVersion "1.0" and every save failed with "Review the setup fields and try again." The setup version now has its own key.
describe('claimed agent setup save', () => {
  it('saves with the setup version the page loaded, and a stale version is refused', async () => {
    const agent = await (await ownerClient.request('GET', `/v1/agents/${owner.agentId}`)).json();
    expect(Number.isSafeInteger(agent.setupVersion)).toBe(true);
    const body = { expectedVersion: agent.setupVersion, selectedCapabilityIds: agent.setup.selectedCapabilityIds, missingContext: 'We also do gutters.' };
    const saved = await ownerClient.request('PATCH', `/v1/agents/${owner.agentId}/setup`, { body });
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.setup).toMatchObject({ state: 'saved', missingContext: 'We also do gutters.' });
    expect(after.setupVersion).toBe(agent.setupVersion + 1);
    const stale = await ownerClient.request('PATCH', `/v1/agents/${owner.agentId}/setup`, { body });
    expect(stale.status).toBe(409);
  });
});
