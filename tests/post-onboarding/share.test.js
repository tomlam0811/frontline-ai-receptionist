import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { readGuestProjection } from '../../server/api/post-onboarding/guest.js';
import { markShareActive, markShareConsumed, expireDueShares } from '../../server/api/post-onboarding/share.js';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, fakeVoice, hash, seedClaimedOwner, seedSession, startServer } from './fixtures.js';

let pg; let app; let voice; let owner; let ownerClient; let ended; let calls;
/** @param {string} path @param {{method?: string, cookie?: string, body?: unknown, headers?: Record<string, string>}} [options] */
const guestCall = (path, { method = 'POST', cookie, body, headers = {} } = {}) => app.fetch(`${app.baseUrl}${path}`, {
  method, headers: { origin: app.baseUrl, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : { 'x-frontline-guest': '1' }), ...headers }, body: body ? JSON.stringify(body) : undefined,
});
const createLink = async (client = ownerClient, agent = owner, key) => (await client.request('POST', `/v1/agents/${agent.agentId}/shares`, { body: { expectedAgentVersionId: agent.agentId }, headers: key ? { 'idempotency-key': key } : {} }));
const tokenOf = (url) => new URL(url).hash.replace('#t=', '');
/** Opens the link like a guest browser: returns the fl_guest cookie header. */
async function openLink(url) {
  const response = await guestCall('/v1/shared/exchange', { body: { token: tokenOf(url) } });
  return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}
const grantRow = (id) => asOwner(pg, async () => (await pg.query('SELECT * FROM frontline_share_grants WHERE id = $1', [id])).rows[0]);
const ownerSql = (sql, params) => asOwner(pg, () => pg.query(sql, params));

beforeEach(async () => {
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg);
  await pg.exec('SET ROLE frontline_app');
  voice = fakeVoice(); ended = []; calls = [];
  app = startServer(pg, { voice, endLiveCall: async (call) => { ended.push(call); }, endGuestDemo: async (call) => { calls.push(call); return { state: 'ending' }; } });
  ownerClient = browserClient(app, owner.authToken);
});

describe('owner share links', () => {
  it('creates a link once, stores only its hash, and never lists the secret', async () => {
    const response = await createLink();
    expect(response.status).toBe(201);
    const share = await response.json();
    expect(share.url).toMatch(/^http:\/\/frontline\.test\/shared#t=[A-Za-z0-9_-]{43}$/);
    expect(share).toMatchObject({ status: 'unused', agentVersionId: owner.agentId });
    const hours = (Date.parse(share.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9); expect(hours).toBeLessThan(24.1);
    const row = await grantRow(share.shareId);
    expect(row.token_hash).toBe(hash(tokenOf(share.url)));
    expect(JSON.stringify(row)).not.toContain(tokenOf(share.url));
    const list = await (await ownerClient.request('GET', `/v1/agents/${owner.agentId}/shares`)).json();
    expect(list.shares).toHaveLength(1);
    expect(list.shares[0]).toMatchObject({ shareId: share.shareId, status: 'unused', versionLabel: 'Version 1', isCurrentVersion: true, version: 1 });
    expect(JSON.stringify(list)).not.toContain(tokenOf(share.url));
    expect(JSON.stringify(list)).not.toContain('token');
  });

  it('replays an idempotent create without the secret and rejects a different agent version', async () => {
    const first = await (await createLink(ownerClient, owner, 'k1')).json();
    const replay = await createLink(ownerClient, owner, 'k1');
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(await replay.json()).toMatchObject({ shareId: first.shareId, url: null });
    const stale = await ownerClient.request('POST', `/v1/agents/${owner.agentId}/shares`, { body: { expectedAgentVersionId: randomUUID() } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).title).toBe('stale_agent_version');
  });

  it('caps unused links at 5 per agent and frees a slot on revoke', async () => {
    const shares = [];
    for (let i = 0; i < 5; i += 1) shares.push(await (await createLink()).json());
    const sixth = await createLink();
    expect([sixth.status, (await sixth.json()).title]).toEqual([409, 'share_limit_reached']);
    const revoke = await ownerClient.request('DELETE', `/v1/agents/${owner.agentId}/shares/${shares[0].shareId}?expectedVersion=1`);
    expect(await revoke.json()).toMatchObject({ shareId: shares[0].shareId, status: 'revoked' });
    expect((await createLink()).status).toBe(201);
  });

  it('checks the version on revoke, is safe to repeat, and never revokes another owner\'s link', async () => {
    const share = await (await createLink()).json();
    const revoke = (version, client = ownerClient, agent = owner) => client.request('DELETE', `/v1/agents/${agent.agentId}/shares/${share.shareId}?expectedVersion=${version}`);
    expect((await revoke(9)).status).toBe(409);
    expect((await revoke(1)).status).toBe(200);
    expect((await revoke(2)).status).toBe(200);
    const other = await seedClaimedOwner(pg);
    const otherClient = browserClient(app, other.authToken);
    expect((await revoke(1, otherClient, other)).status).toBe(404);
    expect((await revoke(1, ownerClient, other)).status).toBe(404);
  });

  it('requires sign-in and reports voice unavailable when the provider is not configured', async () => {
    expect((await createLink(browserClient(app, null))).status).toBe(404);
    const off = startServer(pg, { voice: { isConfigured: () => false } });
    const response = await createLink(browserClient(off, owner.authToken));
    expect([response.status, (await response.json()).title]).toEqual([503, 'voice_unavailable']);
  });
});

describe('guest link exchange', () => {
  it('opens an unused link with only what the page needs and sets a hashed HttpOnly cookie', async () => {
    const share = await (await createLink()).json();
    const { response, cookie } = await openLink(share.url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: true, businessName: 'Riverside Dental', limits: { maxSeconds: 300, browserOnly: true }, disclosure: { ownerCanReview: true, builderMayReviewFeedback: true } });
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; Path=\/; SameSite=Strict/);
    const value = cookie.split('=')[1];
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect((await ownerSql('SELECT count(*)::int AS n FROM frontline_guest_capabilities WHERE capability_hash = $1', [hash(value)])).rows[0].n).toBe(1);
    expect((await ownerSql('SELECT count(*)::int AS n FROM frontline_guest_capabilities WHERE capability_hash = $1', [value])).rows[0].n).toBe(0);
    expect((await grantRow(share.shareId)).status).toBe('unused');
  });

  it.each([['garbage'], ['A'.repeat(43)]])('answers one neutral 404 for an unknown token (%s)', async (token) => {
    const response = await guestCall('/v1/shared/exchange', { body: { token } });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ title: 'link_unavailable', reason: 'unavailable' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('reports revoked and expired links with the fixed reasons', async () => {
    const revoked = await (await createLink()).json();
    await ownerClient.request('DELETE', `/v1/agents/${owner.agentId}/shares/${revoked.shareId}?expectedVersion=1`);
    expect((await (await guestCall('/v1/shared/exchange', { body: { token: tokenOf(revoked.url) } })).json()).reason).toBe('revoked');
    const expired = await (await createLink()).json();
    await ownerSql("UPDATE frontline_share_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.shareId]);
    expect((await (await guestCall('/v1/shared/exchange', { body: { token: tokenOf(expired.url) } })).json()).reason).toBe('expired');
    expect((await grantRow(expired.shareId)).status).toBe('expired');
  });

  it('rejects other origins and non-JSON bodyless requests', async () => {
    const share = await (await createLink()).json();
    const evil = await guestCall('/v1/shared/exchange', { body: { token: tokenOf(share.url) }, headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const { cookie } = await openLink(share.url);
    const noHeader = await app.fetch(`${app.baseUrl}/v1/shared/start`, { method: 'POST', headers: { origin: app.baseUrl, cookie } });
    expect(noHeader.status).toBe(403);
  });
});

describe('starting the one conversation', () => {
  async function ready() {
    const share = await (await createLink()).json();
    const { cookie } = await openLink(share.url);
    return { share, cookie };
  }

  it('reserves the grant, the paid reservation and the demo together, then returns room credentials', async () => {
    const { share, cookie } = await ready();
    const response = await guestCall('/v1/shared/start', { cookie });
    expect(response.status).toBe(201);
    const credentials = await response.json();
    expect(credentials).toMatchObject({ livekitUrl: 'wss://voice.test', participantToken: 'token-1' });
    const grant = await grantRow(share.shareId);
    expect(grant).toMatchObject({ status: 'reserved', lease_generation: 1 });
    expect(grant.demo_id).toBe(credentials.demoId);
    const reservation = (await ownerSql('SELECT * FROM voice_start_reservations WHERE grant_id = $1', [share.shareId])).rows[0];
    expect(reservation).toMatchObject({ mode: 'shared_guest', state: 'reserved', owner_scope_id: owner.scopeId, stable_agent_id: owner.agentId });
    expect(grant.reservation_id).toBe(reservation.id);
    expect(Number((await ownerSql('SELECT reserved_cents FROM voice_daily_budget')).rows[0].reserved_cents)).toBe(100);
    const demo = (await ownerSql("SELECT state->'demos'->$2::text AS demo FROM scoped_workspace_states WHERE owner_scope_id = $1", [owner.scopeId, credentials.demoId])).rows[0].demo;
    expect(demo).toMatchObject({ mode: 'shared_guest', state: 'waiting', stableAgentId: owner.agentId, agentVersionId: owner.agentId, shareGrantId: share.shareId, leaseGeneration: 1, reservationId: reservation.id });
    expect((await ownerSql('SELECT owner_scope_id FROM internal_demo_scopes WHERE demo_id = $1', [credentials.demoId])).rows[0].owner_scope_id).toBe(owner.scopeId);
    expect((await ownerSql('SELECT state, phase FROM demo_deadline_ledger WHERE demo_id = $1', [credentials.demoId])).rows[0]).toMatchObject({ state: 'active', phase: 'setup' });
  });

  it('answers a retry from the same browser with the same conversation, and every other opener is busy', async () => {
    const { share, cookie } = await ready();
    const first = await (await guestCall('/v1/shared/start', { cookie })).json();
    const retry = await guestCall('/v1/shared/start', { cookie });
    expect(retry.status).toBe(201);
    expect((await retry.json()).demoId).toBe(first.demoId);
    expect(voice.started).toHaveLength(1);
    const second = await openLink(share.url);
    expect(second.response.status).toBe(404);
    const other = await guestCall('/v1/shared/start', { cookie: 'fl_guest=' + 'a'.repeat(64) });
    expect(other.status).toBe(401);
  });

  it('marks every other opened preview denied so only one browser can start', async () => {
    const share = await (await createLink()).json();
    const a = await openLink(share.url); const b = await openLink(share.url);
    expect((await guestCall('/v1/shared/start', { cookie: a.cookie })).status).toBe(201);
    const denied = await guestCall('/v1/shared/start', { cookie: b.cookie });
    expect(denied.status).toBe(401);
    expect(Number((await ownerSql("SELECT count(*) AS n FROM frontline_guest_capabilities WHERE kind = 'session'")).rows[0].n)).toBe(1);
  });

  it('keeps the link unused when the paid reservation is denied', async () => {
    const tight = startServer(pg, { voice, guestConfig: { readinessSeconds: 90, sessionTtlSeconds: 90_000, previewTtlSeconds: 3600, reservationTtlSeconds: 600, scopeDailyMax: 3, agentActiveMax: 1, dailyCapCents: 50, reservedCents: 100, globalConcurrent: 5, callArchitectureVersion: 'legacy-v1' } });
    const share = await (await createLink()).json();
    const response = await (async () => { const opened = await tight.fetch(`${tight.baseUrl}/v1/shared/exchange`, { method: 'POST', headers: { origin: tight.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: tokenOf(share.url) }) }); const cookie = opened.headers.get('set-cookie').split(';')[0]; return tight.fetch(`${tight.baseUrl}/v1/shared/start`, { method: 'POST', headers: { origin: tight.baseUrl, cookie, 'x-frontline-guest': '1' } }); })();
    expect([response.status, (await response.json()).title]).toEqual([429, 'voice_limit_reached']);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'unused', lease_generation: 0, demo_id: null });
    expect(Number((await ownerSql('SELECT count(*) AS n FROM voice_start_reservations')).rows[0].n)).toBe(0);
    expect(voice.started).toHaveLength(0);
  });

  it('releases the link and the reservation when dispatch fails and the room is confirmed gone', async () => {
    const { share, cookie } = await ready();
    voice.failStart = true;
    const failed = await guestCall('/v1/shared/start', { cookie });
    expect([failed.status, (await failed.json()).title]).toEqual([503, 'voice_unavailable']);
    expect(voice.ended).toHaveLength(1);
    expect(await grantRow(share.shareId)).toMatchObject({ status: 'unused', lease_generation: 1, reservation_id: null, demo_id: null });
    expect((await ownerSql("SELECT state FROM voice_start_reservations WHERE grant_id = $1", [share.shareId])).rows[0].state).toBe('released');
    expect(Number((await ownerSql('SELECT reserved_cents FROM voice_daily_budget')).rows[0].reserved_cents)).toBe(0);
    voice.failStart = false;
    const retry = await guestCall('/v1/shared/start', { cookie });
    expect(retry.status).toBe(201);
    expect((await grantRow(share.shareId)).lease_generation).toBe(2);
  });

  it('keeps the link reserved (no second session) when the room cannot be confirmed gone', async () => {
    const { share, cookie } = await ready();
    voice.failStart = true; voice.failEnd = true;
    expect((await guestCall('/v1/shared/start', { cookie })).status).toBe(503);
    expect((await grantRow(share.shareId)).status).toBe('reserved');
    expect((await ownerSql("SELECT state FROM voice_start_reservations WHERE grant_id = $1", [share.shareId])).rows[0].state).toBe('reserved');
    voice.failStart = false;
    const again = await guestCall('/v1/shared/start', { cookie });
    expect([again.status, (await again.json()).title]).toEqual([503, 'voice_unavailable']);
    expect(voice.started).toHaveLength(1);
  });

  it('allows one live conversation per agent even across links, enforced by the database', async () => {
    const a = await (await createLink()).json(); const b = await (await createLink()).json();
    const ca = (await openLink(a.url)).cookie; const cb = (await openLink(b.url)).cookie;
    expect((await guestCall('/v1/shared/start', { cookie: ca })).status).toBe(201);
    const second = await guestCall('/v1/shared/start', { cookie: cb });
    expect([second.status, (await second.json()).title]).toEqual([409, 'link_busy']);
    expect((await grantRow(b.shareId)).status).toBe('unused');
    await expect(ownerSql("UPDATE frontline_share_grants SET status = 'reserved' WHERE id = $1", [b.shareId])).rejects.toThrow(/duplicate key|unique/);
  });

  it('enforces the per-day guest start limit of 3 per owner', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const share = await (await createLink()).json();
      const { cookie } = await openLink(share.url);
      const response = await guestCall('/v1/shared/start', { cookie });
      results.push(response.status);
      if (response.status === 201) {
        const { demoId } = await response.json();
        const grant = await grantRow(share.shareId);
        const db = fromPglite(pg);
        await markShareActive({ db, demo: { shareGrantId: share.shareId, leaseGeneration: grant.lease_generation } });
        await markShareConsumed({ db, demo: { shareGrantId: share.shareId, leaseGeneration: grant.lease_generation }, reason: 'ended' });
        await ownerSql("SELECT settle_voice_start($1::uuid,'completed')", [grant.reservation_id]);
        expect(demoId).toBeTruthy();
      }
    }
    expect(results).toEqual([201, 201, 201, 429]);
  });
});

describe('lifecycle fencing and terminal states', () => {
  it('moves reserved to active to consumed only with the current lease generation', async () => {
    const share = await (await createLink()).json();
    const { cookie } = await openLink(share.url);
    await guestCall('/v1/shared/start', { cookie });
    const db = fromPglite(pg);
    const stale = { shareGrantId: share.shareId, leaseGeneration: 0 };
    const current = { shareGrantId: share.shareId, leaseGeneration: 1 };
    expect(await markShareActive({ db, demo: stale })).toBe(false);
    expect(await markShareConsumed({ db, demo: current, reason: 'early' })).toBe(false);
    expect(await markShareActive({ db, demo: current })).toBe(true);
    expect((await grantRow(share.shareId)).status).toBe('active');
    expect(await markShareConsumed({ db, demo: stale, reason: 'late worker' })).toBe(false);
    expect(await markShareConsumed({ db, demo: current, reason: 'caller_ended' })).toBe(true);
    expect((await grantRow(share.shareId))).toMatchObject({ status: 'consumed', terminal_reason: 'caller_ended' });
    expect((await (await guestCall('/v1/shared/exchange', { body: { token: tokenOf(share.url) } })).json()).reason).toBe('used');
    expect(await markShareActive({ db, demo: current })).toBe(false);
  });

  it('revoking a live conversation reports it so the caller can end it, and blocks the guest', async () => {
    const share = await (await createLink()).json();
    const { cookie } = await openLink(share.url);
    const credentials = await (await guestCall('/v1/shared/start', { cookie })).json();
    const revoke = await ownerClient.request('DELETE', `/v1/agents/${owner.agentId}/shares/${share.shareId}?expectedVersion=${(await grantRow(share.shareId)).version}`);
    expect(revoke.status).toBe(200);
    expect(ended).toEqual([expect.objectContaining({ scopeId: owner.scopeId, demoId: credentials.demoId, reason: 'share_revoked' })]);
    expect((await guestCall('/v1/shared/session', { method: 'GET', cookie })).status).toBe(401);
  });

  it('expires overdue unused and live links and returns live ones to end', async () => {
    const unused = await (await createLink()).json();
    const live = await (await createLink()).json();
    const { cookie } = await openLink(live.url);
    const { demoId } = await (await guestCall('/v1/shared/start', { cookie })).json();
    await ownerSql("UPDATE frontline_share_grants SET expires_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])", [[unused.shareId, live.shareId]]);
    const endedByExpiry = [];
    expect(await expireDueShares({ db: fromPglite(pg), endLiveCall: async (call) => { endedByExpiry.push(call); } })).toEqual({ expired: 2 });
    expect(endedByExpiry).toEqual([expect.objectContaining({ demoId, reason: 'share_expired' })]);
    expect((await grantRow(unused.shareId)).status).toBe('expired');
    expect((await grantRow(live.shareId)).status).toBe('expired');
  });
});

describe('the guest session', () => {
  async function started() {
    const share = await (await createLink()).json();
    const { cookie } = await openLink(share.url);
    const credentials = await (await guestCall('/v1/shared/start', { cookie })).json();
    return { share, cookie, credentials };
  }

  it('reports its own conversation state and reconnects to the same room before the deadline', async () => {
    const { cookie, credentials } = await started();
    const session = await (await guestCall('/v1/shared/session', { method: 'GET', cookie })).json();
    expect(session).toMatchObject({ linkStatus: 'reserved', demo: { demoId: credentials.demoId, mode: 'shared_guest', state: 'waiting' } });
    const reconnect = await guestCall('/v1/shared/reconnect', { cookie });
    expect(await reconnect.json()).toMatchObject({ demoId: credentials.demoId, participantToken: 'reconnect-1' });
    await ownerSql("UPDATE scoped_workspace_states SET state = jsonb_set(state, ARRAY['demos', $2, 'setupDeadlineAt'], to_jsonb(to_char(now() - interval '1 minute', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))) WHERE owner_scope_id = $1", [owner.scopeId, credentials.demoId]);
    const late = await guestCall('/v1/shared/reconnect', { cookie });
    expect([late.status, (await late.json()).title]).toEqual([409, 'session_ended']);
  });

  it('sends the guest end request only for its own demo', async () => {
    const { cookie, credentials } = await started();
    expect((await (await guestCall('/v1/shared/end', { cookie })).json()).state).toBe('ending');
    expect(calls).toEqual([{ scopeId: owner.scopeId, demoId: credentials.demoId }]);
  });

  it('exposes nothing about the owner, other conversations or knowledge', async () => {
    const other = randomUUID();
    await ownerSql("UPDATE scoped_workspace_states SET state = jsonb_set(state, ARRAY['demos', $2], '{\"id\":\"x\",\"mode\":\"business_demo\",\"secret\":\"OTHER-DEMO-SENTINEL\"}'::jsonb) WHERE owner_scope_id = $1", [owner.scopeId, other]);
    const { cookie } = await started();
    const bodies = [];
    for (const path of ['/v1/shared/session', '/v1/shared/result']) bodies.push(await (await guestCall(path, { method: 'GET', cookie })).text());
    const text = bodies.join(' ');
    for (const forbidden of ['PRIVATE-KNOWLEDGE-SENTINEL', 'OTHER-DEMO-SENTINEL', owner.scopeId, owner.tenant, 'knowledgeBase', 'agents']) expect(text).not.toContain(forbidden);
    const projection = await readGuestProjection(fromPglite(pg), { scopeId: owner.scopeId, status: 'reserved', demoId: other });
    expect(Object.keys(projection.demo).sort()).toEqual(['demoId', 'hardEndAt', 'mode', 'setupDeadlineAt', 'softCloseAt', 'startedAt', 'state', 'terminalReason']);
  });

  it('keeps guests out of owner and builder routes, and owners out of guest routes', async () => {
    const { cookie } = await started();
    for (const path of [`/v1/agents/${owner.agentId}/shares`, `/v1/agents/${owner.agentId}/feedback`, '/v1/builder/feedback']) {
      const response = await app.fetch(`${app.baseUrl}${path}`, { method: 'GET', headers: { origin: app.baseUrl, cookie } });
      expect([401, 403, 404]).toContain(response.status);
    }
    const ownerAsGuest = await guestCall('/v1/shared/session', { method: 'GET', cookie: `fl_auth=${owner.authToken}` });
    expect(ownerAsGuest.status).toBe(401);
  });

  it('takes guest feedback only after the conversation ends and for 24 hours', async () => {
    const { share, cookie, credentials } = await started();
    const feedback = { category: 'quality', inputMethod: 'text', text: 'Blake was clear about the cleaning price.' };
    expect((await guestCall('/v1/shared/feedback', { cookie, body: feedback })).status).toBe(401);
    const db = fromPglite(pg);
    const demo = { shareGrantId: share.shareId, leaseGeneration: 1 };
    await markShareActive({ db, demo }); await markShareConsumed({ db, demo, reason: 'caller_ended' });
    const sent = await guestCall('/v1/shared/feedback', { cookie, body: feedback });
    expect(sent.status).toBe(201);
    const builder = await seedSession(pg, { builder: true });
    const found = await (await browserClient(app, builder.authToken).request('GET', '/v1/builder/feedback?q=cleaning')).json();
    expect(found.records[0]).toMatchObject({ source: 'guest', conversationId: credentials.demoId, agentId: owner.agentId, agentVersionId: owner.agentId });
    await ownerSql("UPDATE frontline_share_grants SET consumed_at = now() - interval '25 hours' WHERE id = $1", [share.shareId]);
    const closed = await guestCall('/v1/shared/feedback', { cookie, body: { ...feedback, text: 'later' } });
    expect([closed.status, (await closed.json()).title]).toEqual([403, 'feedback_window_closed']);
  });
});

describe('runtime role isolation for share tables and reservations', () => {
  it('cannot read or write the share tables or call internal helpers directly', async () => {
    for (const sql of ['SELECT * FROM frontline_share_grants', 'SELECT * FROM frontline_guest_capabilities', "UPDATE frontline_share_grants SET status = 'consumed'"]) {
      await expect(pg.query(sql)).rejects.toThrow(/permission denied/);
    }
  });
  it('reserve_voice_start_claimed refuses a scope the caller did not set, anonymous scopes and bad modes', async () => {
    const call = (scope, mode, grant) => pg.query('SELECT * FROM reserve_voice_start_claimed($1::uuid,$2::uuid,$3,$4::uuid,10000,100,5,600,3,1)', [scope, owner.agentId, mode, grant]);
    await expect(call(owner.scopeId, 'owner_test', null)).rejects.toThrow(/owner scope mismatch/);
    await pg.exec(`SELECT set_config('app.owner_scope_id', '${owner.scopeId}', false)`);
    expect((await call(owner.scopeId, 'business_demo', null)).rows[0]).toMatchObject({ approved: false, reason: 'invalid_budget_configuration' });
    expect((await call(owner.scopeId, 'shared_guest', null)).rows[0]).toMatchObject({ approved: false, reason: 'invalid_budget_configuration' });
    expect((await call(owner.scopeId, 'owner_test', randomUUID())).rows[0]).toMatchObject({ approved: false, reason: 'invalid_budget_configuration' });
    const anonymous = randomUUID();
    await asOwner(pg, () => pg.query("INSERT INTO ownership_scopes(id, kind, secret_hash, state, expires_at) VALUES ($1,'anonymous',$2,'anonymous', now() + interval '1 hour')", [anonymous, 'b'.repeat(64)]));
    await pg.exec(`SELECT set_config('app.owner_scope_id', '${anonymous}', false)`);
    expect((await call(anonymous, 'owner_test', null)).rows[0]).toMatchObject({ approved: false, reason: 'workspace_unavailable' });
  });
});
