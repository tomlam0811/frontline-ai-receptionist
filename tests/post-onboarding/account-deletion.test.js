import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { runAccountDeletion, startAccountDeletion, sweepAccountDeletions } from '../../server/api/post-onboarding/account-deletion.js';
import { createAnonymousRetention } from '../../server/api/retention.js';
import { startConnectedApi } from './connected-api.js';
import { asOwner, browserClient, hash, hex64, seedClaimedOwner, seedSession } from './fixtures.js';
import { callerSays, guestFetch, terminalPath, tokenOf, workerReady } from './ui-calls.js';

// PO-D12, PO-R14, PO-A20, PO-T14: delete the signed-in owner's whole account. Real handler (createApiHandler with the
// post-onboarding routes), real migrations, role grants and row level security on an in-process Postgres. Only the paid
// LiveKit provider is faked.
const SENTINEL = 'ACCOUNT-CONVERSATION-SENTINEL';
let ctx; let db;

beforeEach(async () => { ctx = await startConnectedApi(); db = fromPglite(ctx.pg); });
afterEach(() => { ctx.restore(); });

const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null), cookies: response.headers.get('set-cookie') ?? '' });
const deleteAccount = (client = ctx.ownerClient) => client.request('DELETE', '/v1/me/account').then(json);
const listAgents = (client) => client.request('GET', '/v1/me/agents').then(json);
const sql = (text, params) => ctx.ownerSql(text, params).then((result) => result.rows);
const count = async (text, params) => (await sql(text, params))[0].n;

/** Every row outside the scope JSON that belongs to one business, by table. */
async function rowsFor(scopeId) {
  const tables = ['scoped_workspace_states', 'internal_demo_scopes', 'demo_deadline_ledger', 'voice_start_reservations', 'preparation_jobs', 'frontline_share_grants', 'frontline_claim_grants', 'frontline_claimed_targets', 'frontline_claim_audit', 'frontline_claim_outbox'];
  const out = {};
  for (const table of tables) out[table] = await count(`SELECT count(*)::int AS n FROM ${table} WHERE owner_scope_id = $1`, [scopeId]);
  out.guest_capabilities = await count('SELECT count(*)::int AS n FROM frontline_guest_capabilities c JOIN frontline_share_grants g ON g.id = c.grant_id WHERE g.owner_scope_id = $1', [scopeId]);
  return out;
}
const scopeRow = async (scopeId) => (await sql('SELECT state, tenant_id FROM ownership_scopes WHERE id = $1', [scopeId]))[0] ?? null;
const jobRow = async () => (await sql('SELECT * FROM frontline_account_deletions'))[0] ?? null;

/** Claim history, a research job and feedback, as a real claim and use would leave them. */
async function addClaimRecords(owner) {
  const demoId = randomUUID();
  await sql(`INSERT INTO frontline_claim_grants(secret_hash, owner_scope_id, demo_id, target_kind, target_id, expires_at, consumed_at, consumed_subject, claimed_tenant_id)
             VALUES ($1,$2,$3,'agent',$4,now() + interval '10 minutes', now(), $5, $6)`, [hex64(), owner.scopeId, demoId, owner.agentId, owner.subject, owner.tenant]);
  await sql('INSERT INTO frontline_claim_audit(owner_scope_id, target_kind, target_id, provider_subject, tenant_id) VALUES ($1,\'agent\',$2,$3,$4)', [owner.scopeId, owner.agentId, owner.subject, owner.tenant]);
  await sql('INSERT INTO frontline_claim_outbox(event_type, owner_scope_id, target_kind, target_id, tenant_id) VALUES (\'claim.consumed\',$1,\'agent\',$2,$3)', [owner.scopeId, owner.agentId, owner.tenant]);
  await sql("INSERT INTO preparation_jobs(id, owner_scope_id, client_hash, state) VALUES ($1,$2,$3,'complete')", [randomUUID(), owner.scopeId, hex64()]);
}
const addFeedback = (owner, text = 'feedback already sent') => sql(
  `INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
   VALUES ('owner','text','quality',$1,$2,$3,$3,'owner',$4,$5,$4,now() + interval '30 days') RETURNING id`, [text, owner.scopeId, owner.agentId, hash(owner.subject), randomUUID()]);

/** A second business the same person claimed (each claim makes its own tenant), with its own receptionist. */
async function addSecondBusiness(owner) {
  return asOwner(ctx.pg, async () => {
    const scopeId = randomUUID(); const agentId = randomUUID();
    const tenant = (await ctx.pg.query('INSERT INTO frontline_tenants DEFAULT VALUES RETURNING id')).rows[0].id;
    await ctx.pg.query("INSERT INTO ownership_scopes(id, kind, secret_hash, state, expires_at, tenant_id) VALUES ($1,'tenant',$2,'claimed',NULL,$3)", [scopeId, hex64(), tenant]);
    await ctx.pg.query("INSERT INTO frontline_memberships(tenant_id, provider_subject, role) VALUES ($1,$2,'owner')", [tenant, owner.subject]);
    await ctx.pg.query("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('agent',$1,$2,$3)", [agentId, scopeId, tenant]);
    const state = { workspaces: { [scopeId]: { id: scopeId, state: 'claimed' } }, agents: { [agentId]: { id: agentId, workspaceId: scopeId, knowledgeRevisionId: 'k2' } }, knowledge: { k2: { id: 'k2', workspaceId: scopeId, facts: ['SECOND-BUSINESS-SENTINEL'] } }, demos: {} };
    await ctx.pg.query('INSERT INTO scoped_workspace_states(owner_scope_id, state) VALUES ($1,$2::jsonb)', [scopeId, JSON.stringify(state)]);
    return { scopeId, agentId, tenant };
  });
}

/** Owner feedback through the real route, so its event row is written too. Returns the feedback id. */
const sendFeedback = async (text) => {
  const response = await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/feedback`, { body: { category: 'quality', inputMethod: 'text', text }, headers: { 'idempotency-key': randomUUID() } });
  expect(response.status).toBe(201);
  return (await response.json()).feedbackId;
};
const guestFeedback = { category: 'quality', inputMethod: 'text', text: 'It was clear.' };

/** One owner with a finished owner test (with what the caller said), an unused link, a live shared call, claim history and feedback. */
async function seedBusyAccount() {
  const test = await ctx.startOwnerTest();
  await ctx.workerCall(test, 'ready');
  await callerSays(ctx.pg, ctx.owner.scopeId, test.id, SENTINEL);
  expect((await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/tests/${test.id}/end`, { body: {} })).status).toBe(200);
  const version = (await (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json()).currentAgentVersionId;
  const unused = await (await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/shares`, { body: { expectedAgentVersionId: version } })).json();
  const live = await ctx.startGuestCall();
  await addClaimRecords(ctx.owner);
  const feedbackIds = [await sendFeedback('feedback already sent'), await sendFeedback('more feedback already sent')];
  return { test, unused, live, feedbackIds };
}

describe('PO-T14 delete an account', () => {
  it('removes every business, receptionist, conversation and link of the person, ends live calls, and signs them out everywhere', async () => {
    const busy = await seedBusyAccount();
    const second = await addSecondBusiness(ctx.owner);
    const otherSession = await seedSession(ctx.pg, { subject: ctx.owner.subject });
    const other = await seedClaimedOwner(ctx.pg, { researched: true });
    const otherClient = browserClient(ctx.app, other.authToken);
    const otherBefore = { rows: await rowsFor(other.scopeId), state: (await sql('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [other.scopeId]))[0].state };
    expect((await listAgents(ctx.ownerClient)).body.agents).toHaveLength(2);
    const before = await rowsFor(ctx.owner.scopeId);
    for (const table of ['scoped_workspace_states', 'internal_demo_scopes', 'demo_deadline_ledger', 'voice_start_reservations', 'preparation_jobs', 'frontline_share_grants', 'frontline_claim_grants', 'frontline_claimed_targets', 'frontline_claim_audit', 'frontline_claim_outbox', 'guest_capabilities']) {
      expect(before[table], `seeded ${table}`).toBeGreaterThan(0);
    }

    const deleted = await deleteAccount();
    expect(deleted.status).toBe(202);
    expect(deleted.body).toMatchObject({ status: 'deleted' });
    // The answer ends the browser's sign-in: session, profile cookies and the owner target hint.
    for (const name of ['fl_auth', 'fl_first_name', 'fl_last_name', 'fl_email', 'fl_owner_target']) expect(deleted.cookies).toMatch(new RegExp(`${name}=;[^,]*Max-Age=0`));
    // The live shared call ended through the terminal path before the answer.
    expect(ctx.voice.ended).toContain(busy.live.demo.id);
    await ctx.api.postOnboardingIdle();

    // Both businesses and everything outside their scope JSON are gone.
    for (const scopeId of [ctx.owner.scopeId, second.scopeId]) {
      expect(Object.values(await rowsFor(scopeId)).every((n) => n === 0), `${scopeId} ${JSON.stringify(await rowsFor(scopeId))}`).toBe(true);
    }
    expect(await scopeRow(second.scopeId)).toBeNull();
    // Feedback already sent stays for its 30 days, so its scope row stays as an empty `deleted` row with no tenant.
    expect(await count('SELECT count(*)::int AS n FROM frontline_feedback WHERE id = ANY($1::uuid[])', [busy.feedbackIds])).toBe(2);
    expect(await count('SELECT count(*)::int AS n FROM frontline_feedback_events WHERE feedback_id = ANY($1::uuid[])', [busy.feedbackIds])).toBe(2);
    // Kept feedback no longer carries the person's one-way reference, and its rows do not share one.
    const ref = hash(ctx.owner.subject);
    expect(await count('SELECT count(*)::int AS n FROM frontline_feedback WHERE creator_ref = $1', [ref])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM frontline_feedback_events WHERE actor_ref = $1', [ref])).toBe(0);
    expect(await count('SELECT count(DISTINCT creator_ref)::int AS n FROM frontline_feedback WHERE id = ANY($1::uuid[])', [busy.feedbackIds])).toBe(2);
    expect(await scopeRow(ctx.owner.scopeId)).toEqual({ state: 'deleted', tenant_id: null });
    expect(await count('SELECT count(*)::int AS n FROM frontline_tenants WHERE id = ANY($1::uuid[])', [[ctx.owner.tenant, second.tenant]])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM frontline_memberships WHERE provider_subject = $1', [ctx.owner.subject])).toBe(0);
    // No row names the person any more, and every one of their sessions is revoked.
    expect(await count('SELECT count(*)::int AS n FROM frontline_auth_sessions WHERE provider_subject = $1', [ctx.owner.subject])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM frontline_auth_sessions WHERE secret_hash = ANY($1) AND revoked_at IS NOT NULL', [[hash(ctx.owner.authToken), hash(otherSession.authToken)]])).toBe(2);
    expect(await count('SELECT count(*)::int AS n FROM frontline_claim_audit WHERE provider_subject = $1', [ctx.owner.subject])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM frontline_claim_grants WHERE consumed_subject = $1', [ctx.owner.subject])).toBe(0);
    expect(await jobRow()).toMatchObject({ status: 'completed', attempts: 0 });

    // Links and guest sessions no longer work, and the old sign-in is refused on every owner path.
    const reopened = await guestFetch(ctx.app)('/v1/shared/exchange', { body: { token: tokenOf(busy.unused.url) } });
    expect(reopened.status).toBe(404);
    expect((await guestFetch(ctx.app)('/v1/shared/session', { method: 'GET', cookie: busy.live.cookie })).status).toBe(401);
    expect(await listAgents(ctx.ownerClient)).toMatchObject({ status: 401, body: { title: 'sign_in_required' } });
    expect((await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).status).toBe(404);
    expect(await listAgents(browserClient(ctx.app, otherSession.authToken))).toMatchObject({ status: 401, body: { title: 'sign_in_required' } });

    // Signing in again with the same Google account starts fresh, with nothing attached.
    const again = await seedSession(ctx.pg, { subject: ctx.owner.subject });
    expect((await listAgents(browserClient(ctx.app, again.authToken))).body).toMatchObject({ agents: [] });
    // The new sign-in's reference is the one the old feedback carried, and no kept row has it.
    const againRef = (await sql('SELECT frontline_session_subject_ref($1) AS ref', [hash(again.authToken)]))[0].ref;
    expect(againRef).toBe(ref);
    expect(await count('SELECT count(*)::int AS n FROM frontline_feedback WHERE creator_ref = $1', [againRef])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM frontline_feedback_events WHERE actor_ref = $1', [againRef])).toBe(0);

    // Another owner is untouched.
    expect(await rowsFor(other.scopeId)).toEqual(otherBefore.rows);
    expect((await sql('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [other.scopeId]))[0].state).toEqual(otherBefore.state);
    expect((await listAgents(otherClient)).body.agents.map((agent) => agent.stableAgentId)).toEqual([other.agentId]);
  });

  it('shuts out a guest whose call already finished on a consumed link as soon as deletion starts', async () => {
    const call = await ctx.startGuestCall();
    await workerReady(ctx.pg, ctx.owner.scopeId, call.demo.id);
    await terminalPath(ctx.pg)({ scopeId: ctx.owner.scopeId, demoId: call.demo.id });
    expect(await count("SELECT count(*)::int AS n FROM frontline_share_grants WHERE id = $1 AND status = 'consumed'", [call.demo.shareGrantId])).toBe(1);
    const guest = guestFetch(ctx.app);
    expect((await guest('/v1/shared/result', { method: 'GET', cookie: call.cookie })).status).toBe(200);

    // The fence only, before any cleanup: the business still exists.
    await startAccountDeletion({ db, request: { headers: { cookie: `fl_auth=${ctx.owner.authToken}` } } });
    expect((await scopeRow(ctx.owner.scopeId)).state).toBe('deleting');
    expect((await guest('/v1/shared/result', { method: 'GET', cookie: call.cookie })).status).toBe(401);
    expect((await guest('/v1/shared/session', { method: 'GET', cookie: call.cookie })).status).toBe(401);
    expect((await guest('/v1/shared/feedback', { cookie: call.cookie, body: guestFeedback })).status).toBe(401);
    expect(await count("SELECT count(*)::int AS n FROM frontline_feedback WHERE source = 'guest'")).toBe(0);
  });

  it('answers a repeat after a lost response with the same result and one job', async () => {
    await seedBusyAccount();
    const first = await deleteAccount();
    expect(first.status).toBe(202);
    // The browser never saw the answer, so it still sends the old session cookie.
    const repeat = await deleteAccount();
    expect(repeat.status).toBe(202);
    expect(repeat.body).toMatchObject({ status: 'deleted' });
    expect(repeat.cookies).toMatch(/fl_auth=;[^,]*Max-Age=0/);
    await ctx.api.postOnboardingIdle();
    expect(await count('SELECT count(*)::int AS n FROM frontline_account_deletions')).toBe(1);
    expect((await deleteAccount()).status).toBe(202);
    expect((await jobRow()).status).toBe('completed');
  });

  it('deletes an account that never saved a receptionist', async () => {
    const session = await seedSession(ctx.pg);
    const response = await deleteAccount(browserClient(ctx.app, session.authToken));
    expect(response.status).toBe(202);
    await ctx.api.postOnboardingIdle();
    expect(await jobRow()).toMatchObject({ status: 'completed', scope_ids: [] });
    expect(await count('SELECT count(*)::int AS n FROM frontline_auth_sessions WHERE provider_subject = $1', [session.subject])).toBe(0);
  });

  it('keeps a business another member also belongs to, removing only this person', async () => {
    const partner = await seedSession(ctx.pg);
    await sql("INSERT INTO frontline_memberships(tenant_id, provider_subject, role) VALUES ($1,$2,'member')", [ctx.owner.tenant, partner.subject]);
    // The departing person's one-way reference, as a publish records it in the scope JSON and a link records it in SQL.
    const ref = hash(ctx.owner.subject);
    await sql("UPDATE scoped_workspace_states SET state = jsonb_set(state, '{publishedBy}', to_jsonb($2::text)) WHERE owner_scope_id = $1", [ctx.owner.scopeId, ref]);
    const version = (await (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json()).currentAgentVersionId;
    const link = await (await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/shares`, { body: { expectedAgentVersionId: version } })).json();
    const before = await rowsFor(ctx.owner.scopeId);

    expect((await deleteAccount()).status).toBe(202);
    await ctx.api.postOnboardingIdle();

    expect(await jobRow()).toMatchObject({ status: 'completed', scope_ids: [] });
    expect(await scopeRow(ctx.owner.scopeId)).toEqual({ state: 'claimed', tenant_id: ctx.owner.tenant });
    expect(await rowsFor(ctx.owner.scopeId)).toEqual(before);
    expect(await count('SELECT count(*)::int AS n FROM frontline_memberships WHERE tenant_id = $1', [ctx.owner.tenant])).toBe(1);
    const partnerClient = browserClient(ctx.app, partner.authToken);
    expect((await listAgents(partnerClient)).body.agents.map((agent) => agent.stableAgentId)).toEqual([ctx.owner.agentId]);
    expect((await (await partnerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/shares`)).json()).shares.map((share) => share.shareId)).toEqual([link.shareId]);
    // The person is no longer named, even by a one-way reference.
    const state = (await sql('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId]))[0].state;
    expect(JSON.stringify(state)).not.toContain(ref);
    expect(await count('SELECT count(*)::int AS n FROM frontline_share_grants WHERE created_by_ref = $1', [ref])).toBe(0);
    expect(await listAgents(ctx.ownerClient)).toMatchObject({ status: 401, body: { title: 'sign_in_required' } });
  });
});

describe('who may delete an account', () => {
  it('needs a sign-in and the CSRF pair, and changes nothing without them', async () => {
    expect((await deleteAccount(browserClient(ctx.app, null))).status).toBe(401);
    const noCsrf = await ctx.app.fetch(`${ctx.app.baseUrl}/v1/me/account`, { method: 'DELETE', headers: { origin: ctx.app.baseUrl, cookie: `fl_auth=${ctx.owner.authToken}` } });
    expect(noCsrf.status).toBe(403);
    const crossSite = await ctx.app.fetch(`${ctx.app.baseUrl}/v1/me/account`, { method: 'DELETE', headers: { origin: 'https://evil.example', cookie: `fl_auth=${ctx.owner.authToken}; fl_csrf=x`, 'x-frontline-csrf': 'x' } });
    expect(crossSite.status).toBe(403);
    expect((await deleteAccount(browserClient(ctx.app, hex64()))).status).toBe(401);
    expect(await jobRow()).toBeNull();
    expect((await listAgents(ctx.ownerClient)).body.agents).toHaveLength(1);
  });

  it('refuses an expired or signed-out session without deleting anything', async () => {
    const out = await ctx.ownerClient.request('POST', '/v1/auth/logout', { body: {} });
    expect(out.status).toBe(200);
    expect((await deleteAccount()).status).toBe(401);
    expect(await jobRow()).toBeNull();
    expect(await scopeRow(ctx.owner.scopeId)).toMatchObject({ state: 'claimed' });
  });

  it('ignores anything in the request body: the person comes from the session', async () => {
    const other = await seedClaimedOwner(ctx.pg);
    const response = await ctx.ownerClient.request('DELETE', '/v1/me/account', { body: { subject: other.subject, scopeId: other.scopeId } });
    expect(response.status).toBe(202);
    await ctx.api.postOnboardingIdle();
    expect(await scopeRow(other.scopeId)).toMatchObject({ state: 'claimed' });
    expect((await listAgents(browserClient(ctx.app, other.authToken))).status).toBe(200);
  });
});

describe('PO-T14 the job resumes after an interruption', () => {
  const sweepAsWorker = async () => {
    const poolAs = (role) => {
      const run = async (text, params) => { await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec(`SET ROLE ${role}`); return ctx.pg.query(text, params); };
      return { query: run, connect: async () => ({ query: run, release() {} }), end: async () => {} };
    };
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    const counts = await retention.sweepPostOnboarding();
    await ctx.pg.exec('RESET ROLE'); await ctx.pg.exec('SET ROLE frontline_app');
    await retention.close();
    return counts;
  };

  it('finishes a job left after the fence, and one left halfway, with the retention worker sweep as the runtime role', async () => {
    const second = await addSecondBusiness(ctx.owner);
    await addClaimRecords(ctx.owner);
    const { jobId, created } = await startAccountDeletion({ db, request: { headers: { cookie: `fl_auth=${ctx.owner.authToken}` } } });
    expect(created).toBe(true);
    // Fenced at once: nothing resolves for the person, the businesses are still there.
    expect(await listAgents(ctx.ownerClient)).toMatchObject({ status: 401, body: { title: 'sign_in_required' } });
    expect((await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).status).toBe(404);
    expect((await scopeRow(ctx.owner.scopeId)).state).toBe('deleting');
    expect((await scopeRow(second.scopeId)).state).toBe('deleting');
    // A crash after the first business.
    const partial = await runAccountDeletion({ db, jobId, stopAfterScopes: 1 });
    expect(partial).toMatchObject({ status: 'pending' });
    expect(partial.scopesDone).toHaveLength(1);

    const counts = await sweepAsWorker();
    expect(counts).toMatchObject({ accountDeletionJobs: 1, accountDeletionsCompleted: 1 });
    expect(await jobRow()).toMatchObject({ status: 'completed' });
    expect(await scopeRow(ctx.owner.scopeId)).toBeNull();
    expect(await scopeRow(second.scopeId)).toBeNull();
    expect(Object.values(await rowsFor(ctx.owner.scopeId)).every((n) => n === 0)).toBe(true);
    // A repeat changes nothing.
    expect((await runAccountDeletion({ db, jobId })).status).toBe('completed');
    expect(await sweepAccountDeletions({ db })).toMatchObject({ jobs: 0, completed: 0 });
  });

  it('waits while a call is live and no terminal path is available, then finishes once the call has ended', async () => {
    const live = await ctx.startGuestCall();
    const { jobId } = await startAccountDeletion({ db, request: { headers: { cookie: `fl_auth=${ctx.owner.authToken}` } } });
    const waiting = await runAccountDeletion({ db, jobId });
    expect(waiting).toMatchObject({ status: 'pending', failureCode: null, attempts: 0 });
    expect(await count('SELECT count(*)::int AS n FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId])).toBe(1);
    expect((await sweepAccountDeletions({ db })).completed).toBe(0);
    // The call ends through its own path (with its room confirmed gone), then the sweep finishes the job.
    await terminalPath(ctx.pg)({ scopeId: ctx.owner.scopeId, demoId: live.demo.id });
    await sql("UPDATE demo_deadline_ledger SET state = 'ended' WHERE owner_scope_id = $1", [ctx.owner.scopeId]);
    expect(await sweepAccountDeletions({ db })).toMatchObject({ jobs: 1, completed: 1 });
    expect(await scopeRow(ctx.owner.scopeId)).toBeNull();
  });

  it('records a failure when a live call cannot be ended, stays fenced, and a repeated request resumes it', async () => {
    await ctx.startOwnerTest();
    const { jobId } = await startAccountDeletion({ db, request: { headers: { cookie: `fl_auth=${ctx.owner.authToken}` } } });
    const broken = async () => { throw new Error('provider down'); };
    for (let attempt = 0; attempt < 3; attempt += 1) await runAccountDeletion({ db, jobId, endLiveCall: broken });
    expect(await jobRow()).toMatchObject({ status: 'failed', attempts: 3, failure_code: 'sessions_not_ended' });
    expect((await scopeRow(ctx.owner.scopeId)).state).toBe('deleting');
    // A failed job waits 2^attempts minutes after its last attempt, then the sweep retries it however many attempts it
    // has used, and reports it while it is still failing.
    expect(await sweepAccountDeletions({ db })).toMatchObject({ jobs: 0, stuckJobs: 0 });
    await sql("UPDATE frontline_account_deletions SET attempts = 20, updated_at = now() - interval '6 hours'");
    expect(await sweepAccountDeletions({ db, endLiveCall: broken })).toMatchObject({ jobs: 1, completed: 0, stuckJobs: 1 });
    expect(await jobRow()).toMatchObject({ status: 'failed', attempts: 21 });
    // The retention worker has no terminal path: the business waits for the call, still failing, and the sweep says so.
    await sql("UPDATE frontline_account_deletions SET updated_at = now() - interval '6 hours'");
    expect(await sweepAsWorker()).toMatchObject({ accountDeletionJobs: 1, accountDeletionsCompleted: 0, accountDeletionsStuck: 1 });
    expect((await scopeRow(ctx.owner.scopeId)).state).toBe('deleting');
    // The owner asking again resumes it.
    const again = await deleteAccount();
    expect(again.status).toBe(202);
    await ctx.api.postOnboardingIdle();
    expect(await jobRow()).toMatchObject({ status: 'completed' });
    expect(await scopeRow(ctx.owner.scopeId)).toBeNull();
  });

  it('removes what a finished deletion no longer needs once it has expired', async () => {
    await addFeedback(ctx.owner);
    expect((await deleteAccount()).status).toBe(202);
    await ctx.api.postOnboardingIdle();
    expect(await scopeRow(ctx.owner.scopeId)).toEqual({ state: 'deleted', tenant_id: null });
    // Nothing is purged while the session could still repeat the request or feedback still points at the scope.
    expect((await sweepAccountDeletions({ db })).purged).toEqual({ sessions: 0, scopes: 0, jobs: 0 });
    await sql("UPDATE frontline_auth_sessions SET expires_at = now() - interval '1 minute' WHERE provider_subject LIKE 'account-deleted:%'");
    await sql("UPDATE frontline_feedback SET expires_at = now() - interval '1 minute' WHERE owner_scope_id = $1", [ctx.owner.scopeId]);
    const counts = await sweepAsWorker();
    expect(counts.feedback).toBe(1);
    expect(await scopeRow(ctx.owner.scopeId)).toBeNull();
    expect(await count("SELECT count(*)::int AS n FROM frontline_auth_sessions WHERE provider_subject LIKE 'account-deleted:%'")).toBe(0);
    expect(await jobRow()).toBeNull();
  });
});
