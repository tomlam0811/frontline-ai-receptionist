import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiHandler } from '../../server/api/service.js';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createPaidStartGate } from '../../server/api/paid-start-gate.js';
import { revokeShare } from '../../server/api/post-onboarding/share.js';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner, startServer } from './fixtures.js';

// PO-C1 (PO-T8): the existing worker routes, terminal paths and watchdog, driven through the real
// createApiHandler and the real PostgresStore code over an in-process Postgres with the real migrations.
// Only the paid LiveKit provider is faked.
const SERVICE_TOKEN = 'test-service-token-0123456789-abcdefghij';
const ENV = { FRONTLINE_VOICE_SPEND_CAP_USD: '10', FRONTLINE_VOICE_MAX_SESSION_USD: '1', FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX: '3' };

let pg; let voice; let store; let api; let app; let owner; let ownerClient; let savedToken;
beforeAll(() => { savedToken = process.env.FRONTLINE_VOICE_SERVICE_TOKEN; process.env.FRONTLINE_VOICE_SERVICE_TOKEN = SERVICE_TOKEN; });
afterAll(() => { if (savedToken === undefined) delete process.env.FRONTLINE_VOICE_SERVICE_TOKEN; else process.env.FRONTLINE_VOICE_SERVICE_TOKEN = savedToken; });

const tokenOf = (url) => new URL(url).hash.replace('#t=', '');
const ownerSql = (sql, params) => asOwner(pg, () => pg.query(sql, params));
const grantRow = async (id) => (await ownerSql('SELECT * FROM frontline_share_grants WHERE id = $1', [id])).rows[0];
const reservationRow = async (id) => (await ownerSql('SELECT state FROM voice_start_reservations WHERE id = $1', [id])).rows[0];
const spentCents = async () => Number((await ownerSql('SELECT COALESCE(sum(reserved_cents),0) AS cents FROM voice_daily_budget')).rows[0].cents);
const demoRecord = async (demoId) => (await ownerSql("SELECT state->'demos'->$2::text AS demo FROM scoped_workspace_states WHERE owner_scope_id = $1", [owner.scopeId, demoId])).rows[0].demo;

/**
 * Drives the existing API handler without a network socket, as the worker or a browser would.
 * @param {string} method @param {string} path @param {{headers?: Record<string, string>, body?: unknown}} [options]
 */
async function callApi(method, path, { headers = {}, body } = {}) {
  const url = new URL(path, 'http://frontline.test');
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Object.assign(Readable.from(payload), {
    method, url: url.pathname + url.search, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: url.host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  });
  let status; const chunks = [];
  await new Promise((resolve) => {
    const response = { headersSent: false, writeHead(code) { status = code; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve(undefined); }, destroy() { resolve(undefined); } };
    Promise.resolve(api(request, response, url)).catch(resolve);
  });
  return { status, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
}

/** A worker call for one demo, carrying the room, generation and agent binding the service checks. */
/** @param {any} demo @param {string} action @param {unknown} [body] @param {string} [method] */
const workerCall = (demo, action, body = {}, method = 'POST') => callApi(method, `/v1/internal/demos/${demo.id}/${action}`, {
  body: method === 'GET' ? undefined : body,
  headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'x-frontline-room': demo.roomName, 'x-frontline-generation': String(demo.generation), 'x-frontline-agent-version-id': demo.agentVersionId },
});

/** A new share link, opened and started by a guest. Returns the link, the started demo and its worker binding. */
async function startGuestCall() {
  const created = await (await ownerClient.request('POST', `/v1/agents/${owner.agentId}/shares`, { body: { expectedAgentVersionId: owner.agentId } })).json();
  const guestHeaders = { origin: app.baseUrl, 'x-frontline-guest': '1' };
  const opened = await app.fetch(`${app.baseUrl}/v1/shared/exchange`, { method: 'POST', headers: { ...guestHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ token: tokenOf(created.url) }) });
  const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];
  const started = await app.fetch(`${app.baseUrl}/v1/shared/start`, { method: 'POST', headers: { ...guestHeaders, cookie } });
  expect(started.status).toBe(201);
  const { demoId } = await started.json();
  return { share: created, cookie, demo: await demoRecord(demoId) };
}

beforeEach(async () => {
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg);
  await pg.exec('SET ROLE frontline_app');
  voice = Object.assign(fakeVoice(), { isReady: async () => true });
  // A store the handler accepts as Postgres, running on the one in-process connection.
  store = Object.create(PostgresStore.prototype);
  store.ensureReady = async () => {};
  store.pool = { query: (sql, params) => pg.query(sql, params), connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };
  api = createApiHandler({ store, voiceAdapter: voice, paidStartGate: createPaidStartGate(store, ENV), prepareBusiness: async () => ({}), preparationQueue: { start() {}, stop() {}, healthy: () => true } });
  app = startServer(pg, { voice, endLiveCall: api.endClaimedDemo });
  ownerClient = browserClient(app, owner.authToken);
});

describe('worker routes for a claimed scope (migration 015)', () => {
  it('resolves a demo in a claimed scope by its id, and still refuses an unknown demo', async () => {
    const { demo } = await startGuestCall();
    expect((await ownerSql('SELECT resolve_internal_demo_scope($1::uuid) AS id', [demo.id])).rows[0].id).toBe(owner.scopeId);
    expect((await ownerSql('SELECT resolve_internal_demo_scope($1::uuid) AS id', ['00000000-0000-4000-8000-000000000000'])).rows[0].id).toBeNull();
    // The worker route now finds the demo. What /runtime returns for these demos is connected in PO-C4.
    expect((await workerCall(demo, 'runtime', {}, 'GET')).status).not.toBe(404);
  });

  it('stops resolving once the scope is no longer claimed', async () => {
    const { demo } = await startGuestCall();
    await ownerSql("UPDATE ownership_scopes SET state = 'expired' WHERE id = $1", [owner.scopeId]);
    expect((await ownerSql('SELECT resolve_internal_demo_scope($1::uuid) AS id', [demo.id])).rows[0].id).toBeNull();
  });
});

describe('ready and terminal paths (PO-T8)', () => {
  it('activates the link on ready and consumes it, charged, when the call ends', async () => {
    const { share, demo } = await startGuestCall();
    const ready = await workerCall(demo, 'ready');
    expect(ready.status).toBe(200);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'active' });
    // A repeated ready for the same call is idempotent and keeps the link active.
    expect((await workerCall(demo, 'ready')).status).toBe(200);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'active' });

    const ending = await workerCall(demo, 'ending', { expectedStateRevision: (await demoRecord(demo.id)).stateRevision, reason: 'caller_ended' });
    expect(ending.status).toBe(200);
    const terminal = await workerCall(demo, 'terminal', { expectedStateRevision: ending.json.stateRevision, reason: 'caller_ended' });
    expect(terminal.status).toBe(200);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'consumed', terminal_reason: 'caller_ended' });
    expect(voice.ended).toContain(demo.id);
    expect((await reservationRow(demo.reservationId)).state).toBe('completed');
    expect(await spentCents()).toBe(100);
  });

  it('fences a late worker holding an older lease: the call does not start and the link is untouched', async () => {
    const { share, demo } = await startGuestCall();
    // A newer attempt has since taken the link's lease.
    await ownerSql('UPDATE frontline_share_grants SET lease_generation = lease_generation + 1 WHERE id = $1', [share.shareId]);
    const late = await workerCall(demo, 'ready');
    expect(late.status).toBe(409);
    expect(late.json.title).toBe('stale_lease');
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'reserved', activated_at: null });
    expect((await demoRecord(demo.id)).startedAt).toBeNull();
    expect((await ownerSql('SELECT state, phase FROM demo_deadline_ledger WHERE demo_id = $1', [demo.id])).rows[0]).toMatchObject({ phase: 'setup' });
  });

  it('a worker ending the call after readiness consumes the link in the same step', async () => {
    const { share, cookie, demo } = await startGuestCall();
    await workerCall(demo, 'ready');
    const started = await demoRecord(demo.id);
    expect(started.state).toBe('active');
    // The existing worker route also serves the caller-ended reason after readiness.
    const ending = await workerCall(demo, 'ending', { expectedStateRevision: started.stateRevision, reason: 'caller_ended' });
    await workerCall(demo, 'terminal', { expectedStateRevision: ending.json.stateRevision, reason: 'caller_ended' });
    expect((await grantRow(share.shareId)).status).toBe('consumed');
    // A consumed link cannot start a second conversation.
    const again = await app.fetch(`${app.baseUrl}/v1/shared/start`, { method: 'POST', headers: { origin: app.baseUrl, 'x-frontline-guest': '1', cookie } });
    expect(again.status).toBe(409);
  });
});

describe('watchdog and link lifecycle (PO-T8)', () => {
  const dueSetup = async () => (await store.listDueDemos(new Date(Date.now() + 60_000)));
  const runWatchdog = async () => { for (const due of await dueSetup()) { await store.persistHardEnd(due, false); await store.finalizeHardEnd(due); } };

  it('releases the link and the reservation only for a call that never started', async () => {
    const { share, demo } = await startGuestCall();
    expect(await spentCents()).toBe(100);
    await runWatchdog();
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'unused', demo_id: null, reservation_id: null, lease_generation: 1 });
    expect((await reservationRow(demo.reservationId)).state).toBe('released');
    expect(await spentCents()).toBe(0);
    expect((await demoRecord(demo.id)).state).toBe('failed');
  });

  it('keeps the charge and consumes the link for a call that ran until its hard end', async () => {
    const { share, demo } = await startGuestCall();
    await workerCall(demo, 'ready');
    // The hard end has passed: the stored deadline and the durable ledger row agree, as they do in production.
    const past = new Date(Date.now() - 1000).toISOString();
    await ownerSql('UPDATE demo_deadline_ledger SET deadline_at = $2::timestamptz WHERE demo_id = $1', [demo.id, past]);
    await ownerSql('UPDATE scoped_workspace_states SET state = jsonb_set(state, $2::text[], to_jsonb($3::text)) WHERE owner_scope_id = $1', [owner.scopeId, ['demos', demo.id, 'hardEndAt'], past]);
    const due = (await store.listDueDemos(new Date())).find((item) => item.id === demo.id);
    expect(due).toBeTruthy();
    await store.persistHardEnd(due, false);
    await store.finalizeHardEnd(due);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'consumed', terminal_reason: 'hard_end_elapsed' });
    expect((await reservationRow(demo.reservationId)).state).toBe('completed');
    expect(await spentCents()).toBe(100);
  });

  it('ends a live call when its link is revoked, through the terminal path', async () => {
    const { share, demo } = await startGuestCall();
    await workerCall(demo, 'ready');
    const actor = { scopeId: owner.scopeId };
    const grant = await grantRow(share.shareId);
    const revoked = await revokeShare({ db: fromPglite(pg), actor, shareId: share.shareId, expectedVersion: grant.version, endLiveCall: api.endClaimedDemo });
    expect(revoked).toMatchObject({ status: 'revoked' });
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'revoked' });
    expect(await demoRecord(demo.id)).toMatchObject({ state: 'ended', terminalReason: 'hard_end_elapsed' });
    expect(voice.ended).toContain(demo.id);
    expect((await reservationRow(demo.reservationId)).state).toBe('completed');
  });

  it('ends a live call when its link expires, and the sweep is safe to repeat', async () => {
    const { share, demo } = await startGuestCall();
    await workerCall(demo, 'ready');
    await ownerSql("UPDATE frontline_share_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [share.shareId]);
    expect(await api.sweepShareLinks()).toEqual({ expired: 1 });
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'expired', terminal_reason: 'share_expired' });
    expect((await demoRecord(demo.id)).state).toBe('ended');
    expect(voice.ended).toContain(demo.id);
    expect(await api.sweepShareLinks()).toEqual({ expired: 0 });
  });

  it('keeps the reservation when the room cannot be deleted yet, so the watchdog can retry', async () => {
    const { share, demo } = await startGuestCall();
    voice.failEnd = true;
    await ownerSql("UPDATE frontline_share_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [share.shareId]);
    await api.sweepShareLinks();
    expect((await demoRecord(demo.id)).state).toBe('ended');
    expect((await reservationRow(demo.reservationId)).state).toBe('reserved');
  });
});
