import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutOuterTransaction } from '../../scripts/lib/migration-runner.mjs';
import { addReceptionist, defaultSourceIds, RECEPTIONIST_LIMIT, RECEPTIONIST_LIMIT_MESSAGE } from '../../server/api/post-onboarding/create-receptionist.js';
import { backfillKnowledgeLibrary, hasSelectedKnowledge, needsKnowledge, readLineage } from '../../server/api/post-onboarding/lineage.js';
import { startConnectedApi } from './connected-api.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, hash, seedClaimedOwner } from './fixtures.js';
import { scopeState } from './ui-calls.js';

// MR-T1, MR-T2, MR-T13, MR-T14, MR-T16 and idempotent create (multi-receptionist spec MR-D1, MR-D3, MR-D9, MR-D10, MR-J1).
// Real handler, real migrations and role grants on an in-process Postgres. Only the paid LiveKit provider is faked.
let ctx;
beforeAll(async () => { ctx = await startConnectedApi({ apiOptions: { authClaims: { isConfigured: () => true, googleConfigured: () => true } } }); });
afterAll(() => ctx?.restore());

/** A claimed business with one receptionist and its signed-in owner. */
async function world(options = {}) {
  const owner = await seedClaimedOwner(ctx.pg, { researched: true, ...options });
  return { owner, client: browserClient(ctx.app, owner.authToken) };
}
const call = async (client, method, path, body, key) => {
  const response = await client.request(method, path, { ...(body ? { body } : {}), ...(key ? { headers: { 'idempotency-key': key } } : {}) });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
};
const create = (who, body = {}, key = randomUUID(), client = who.client) => call(client, 'POST', '/v1/me/agents', body, key);
const list = async (who) => (await call(who.client, 'GET', '/v1/me/agents')).body.agents;
const at = (id, suffix = '') => `/v1/agents/${id}${suffix}`;
const targetRows = (scopeId) => ctx.ownerSql('SELECT target_kind, target_id, tenant_id FROM frontline_claimed_targets WHERE owner_scope_id = $1 ORDER BY created_at, target_id', [scopeId]).then((result) => result.rows);
const knowledgeOf = async (who, id) => (await call(who.client, 'GET', at(id, '/knowledge'))).body;
const select = (who, id, sourceIds, version) => call(who.client, 'PUT', at(id, '/knowledge-sources-selection'), { sourceIds, expectedAgentVersionId: version });
const startTest = (who, id, version = id) => call(who.client, 'POST', at(id, '/tests'), { expectedAgentVersionId: version });
const share = (who, id, version = id) => call(who.client, 'POST', at(id, '/shares'), { expectedAgentVersionId: version }, randomUUID());
const NEEDS_KNOWLEDGE = (name) => ({ status: 409, title: 'needs_knowledge', detail: `${name} needs knowledge before it can take calls. Choose at least one source.` });
const problemOf = (result) => ({ status: result.status, title: result.body.title, detail: result.body.detail });
const SOURCE = 'src-p1';
const agentOf = async (who, id) => (await list(who)).find((agent) => agent.stableAgentId === id);
/** Creates a share link for a receptionist, opens it as a guest and returns the guest cookie. */
async function openLinkFor(who, id, version = id) {
  const link = await share(who, id, version);
  expect(link.status).toBe(201);
  const token = new URL(link.body.url).hash.replace('#t=', '');
  const opened = await ctx.app.fetch(`${ctx.app.baseUrl}/v1/shared/exchange`, { method: 'POST', headers: { origin: ctx.app.baseUrl, 'x-frontline-guest': '1', 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  expect(opened.status).toBe(200);
  return (opened.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('MR-T1: add a second receptionist', () => {
  it('lists it after the first with its name, version 1 and the onboarding website selected', async () => {
    const who = await world();
    const [first] = await list(who);
    expect(first).toMatchObject({ name: 'Blake', needsKnowledge: false, status: 'active' });

    const made = await create(who, { name: 'Sam' });
    expect(made.status).toBe(201);
    expect(made.headers.get('idempotent-replay')).toBeNull();
    expect(made.body).toMatchObject({ kind: 'agent', name: 'Sam', status: 'active', needsKnowledge: false, businessName: 'Riverside Dental', versionNumber: 1, pointerGeneration: 1, knowledgeState: 'ready', ready: true, untestedChanges: false, firstVisit: { seen: false } });
    expect(made.body.currentAgentVersionId).toBe(made.body.stableAgentId);
    expect(made.body.knownVersionIds).toEqual([made.body.stableAgentId]);
    expect(made.body.stableAgentId).not.toBe(who.owner.agentId);

    const agents = await list(who);
    expect(agents.map((agent) => [agent.stableAgentId, agent.name])).toEqual([[who.owner.agentId, 'Blake'], [made.body.stableAgentId, 'Sam']]);
    const knowledge = await knowledgeOf(who, made.body.stableAgentId);
    expect(knowledge.sourceIds).toEqual([SOURCE]);
    expect(knowledge.sources.find((source) => source.sourceId === SOURCE).usedBy.map((user) => user.name).sort()).toEqual(['Blake', 'Sam']);
    expect((await call(who.client, 'GET', at(made.body.stableAgentId, '/summary'))).body).toMatchObject({ name: 'Sam', versionNumber: 1 });
  });

  it('registers a claimed target for the same scope and tenant, and compiles the same knowledge as the first receptionist', async () => {
    const who = await world();
    const made = (await create(who, { name: 'Sam' })).body;
    const rows = await targetRows(who.owner.scopeId);
    expect(rows.map((row) => row.target_id)).toEqual([who.owner.agentId, made.stableAgentId]);
    expect(new Set(rows.map((row) => row.tenant_id))).toEqual(new Set([who.owner.tenant]));
    expect(rows.every((row) => row.target_kind === 'agent')).toBe(true);

    const state = await scopeState(ctx.pg, who.owner.scopeId);
    const compiled = (id) => state.knowledge[state.agents[id].knowledgeRevisionId];
    const facts = (record) => record.groupedFacts.map((fact) => [fact.factId, fact.value]).sort();
    expect(facts(compiled(made.stableAgentId))).toEqual(facts(compiled(who.owner.agentId)));
    expect(compiled(made.stableAgentId).id).not.toBe(compiled(who.owner.agentId).id);
    expect(state.agentLineages[made.stableAgentId]).toMatchObject({ name: 'Sam', status: 'active', sourceIds: [SOURCE], businessName: 'Riverside Dental' });
    expect(state.agentLineages[who.owner.agentId].sourceIds).toEqual([SOURCE]);
    expect(state.agents[made.stableAgentId].capabilityManifest.workflowCapabilities.every((workflow) => workflow.enabled)).toBe(true);
    // The first receptionist keeps its own version and pointer.
    expect(state.agentLineages[who.owner.agentId]).toMatchObject({ currentAgentVersionId: who.owner.agentId, pointerGeneration: 1 });
  });

  it('is usable: setup, an owner test call named for it and a share link', async () => {
    const who = await world();
    const made = (await create(who, { name: 'Sam' })).body;
    const setup = await call(who.client, 'GET', `/v1/agents/${made.stableAgentId}`);
    expect(setup.status).toBe(200);
    expect(setup.body).toMatchObject({ agentId: made.stableAgentId, claimState: 'claimed', businessName: 'Riverside Dental' });
    expect((await call(who.client, 'GET', `/v1/agents/${who.owner.agentId}`)).body.agentId).toBe(who.owner.agentId);

    const started = await startTest(who, made.stableAgentId);
    expect(started.status).toBe(201);
    const demo = (await scopeState(ctx.pg, who.owner.scopeId)).demos[started.body.demoId];
    expect(demo).toMatchObject({ stableAgentId: made.stableAgentId, agentVersionId: made.stableAgentId, receptionistName: 'Sam' });
    const runtime = await (await ctx.workerCall(demo, 'runtime', {}, {}, 'GET')).json();
    expect(runtime).toMatchObject({ receptionistName: 'Sam', businessName: 'Riverside Dental', agentVersionId: made.stableAgentId });
    expect(runtime.facts.length).toBeGreaterThan(0);
    expect((await call(who.client, 'POST', at(made.stableAgentId, `/tests/${started.body.demoId}/end`))).status).toBe(200);
    expect((await share(who, made.stableAgentId)).status).toBe(201);
  });

  it('lists receptionists in the order they were added, and starts the new one from the default setup', async () => {
    const who = await world();
    const names = ['Zed', 'Amy', 'Mia'];
    for (const name of names) expect((await create(who, { name })).status).toBe(201);
    expect((await list(who)).map((agent) => agent.name)).toEqual(['Blake', ...names]);
  });

  it('starts from every workflow on, whatever the first receptionist switched off', async () => {
    const who = await world();
    const capabilities = await call(who.client, 'GET', at(who.owner.agentId, '/capabilities'));
    const saved = await call(who.client, 'PATCH', at(who.owner.agentId, '/capabilities'), { baseAgentVersionId: capabilities.body.currentAgentVersionId, expectedPointerGeneration: capabilities.body.pointerGeneration, workflows: { 'WF-05': false } }, randomUUID());
    expect(saved.status).toBe(200);
    const made = (await create(who, { name: 'Sam' })).body;
    const view = (await call(who.client, 'GET', at(made.stableAgentId, '/capabilities'))).body;
    expect(view.workflows.filter((workflow) => !workflow.enabled)).toEqual([]);
  });
});

describe('MR-T2: the default name and the default knowledge', () => {
  it('names the receptionist Blake only when the name is free', async () => {
    const who = await world();
    // The first receptionist answers to Blake, so a second one needs a name.
    const refused = await create(who, {});
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ title: 'invalid_name', detail: 'Name the new receptionist. Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.' });
    expect(await list(who)).toHaveLength(1);
    expect((await targetRows(who.owner.scopeId))).toHaveLength(1);

    expect((await call(who.client, 'PATCH', at(who.owner.agentId, '/name'), { name: 'Riley' })).status).toBe(200);
    const made = await create(who, {});
    expect(made.status).toBe(201);
    expect(made.body.name).toBe('Blake');
    // Now Blake is taken again.
    expect((await create(who, {})).status).toBe(422);
  });

  it('refuses a taken or invalid name, ignoring case, and leaves nothing behind', async () => {
    const who = await world();
    const taken = await create(who, { name: 'bLaKe' });
    expect([taken.status, taken.body.title, taken.body.detail]).toEqual([409, 'name_taken', 'That name is already used.']);
    for (const name of ['', '  ', 'x'.repeat(31), '123', 'Sam2', '<b>Sam</b>']) {
      const bad = await create(who, { name });
      expect([bad.status, bad.body.title]).toEqual([422, 'invalid_name']);
    }
    expect((await create(who, { name: 7 })).status).toBe(400);
    expect(await list(who)).toHaveLength(1);
    expect(await targetRows(who.owner.scopeId)).toHaveLength(1);
    expect((await scopeState(ctx.pg, who.owner.scopeId)).receptionistCreates).toBeUndefined();
    expect((await create(who, { name: 'sAm' })).status).toBe(201);
    expect((await create(who, { name: 'SAM' })).body.title).toBe('name_taken');
  });

  it('starts with nothing selected when the onboarding source was removed from the business', async () => {
    const who = await world();
    const knowledge = await knowledgeOf(who, who.owner.agentId);
    const erased = await call(who.client, 'POST', at(who.owner.agentId, `/knowledge-sources/${SOURCE}/erase`), { confirm: true, expectedPointerGeneration: knowledge.pointerGeneration });
    expect(erased.status).toBe(202);
    await ctx.api.postOnboardingIdle();

    const made = await create(who, { name: 'Sam' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Sam', needsKnowledge: true, versionNumber: 1 });
    expect((await scopeState(ctx.pg, who.owner.scopeId)).agentLineages[made.body.stableAgentId].sourceIds).toEqual([]);
    expect((await knowledgeOf(who, made.body.stableAgentId)).sourceIds).toEqual([]);
    expect((await list(who)).find((agent) => agent.stableAgentId === made.body.stableAgentId).needsKnowledge).toBe(true);
  });

  it('selects every selectable onboarding source and nothing else', () => {
    const sources = {
      a: { sourceId: 'a', origin: 'onboarding_website', erasedAt: null },
      b: { sourceId: 'b', origin: 'onboarding_website', erasedAt: null },
      erased: { sourceId: 'erased', origin: 'onboarding_website', erasedAt: '2026-09-01T00:00:00.000Z' },
      erasing: { sourceId: 'erasing', origin: 'onboarding_website', erasureJobId: 'job' },
      notes: { sourceId: 'notes', origin: 'owner_form', erasedAt: null },
    };
    expect(defaultSourceIds({ sources })).toEqual(['a', 'b']);
    expect(defaultSourceIds({ sources: {} })).toEqual([]);
    expect(defaultSourceIds({})).toEqual([]);
  });

  it('falls back to no source when the onboarding facts hold no service, so the receptionist is still created', async () => {
    const seed = await world();
    const state = backfillKnowledgeLibrary((await scopeState(ctx.pg, seed.owner.scopeId)), seed.owner.agentId);
    for (const entry of Object.values(state.knowledgeLibrary.entries)) if (entry.group === 'services') entry.state = 'retracted';
    const stableAgentId = randomUUID();
    const next = addReceptionist(state, { stableAgentId, baseAgentId: seed.owner.agentId, name: 'Sam', now: new Date(), newId: randomUUID });
    expect(next.agentLineages[stableAgentId].sourceIds).toEqual([]);
    expect(needsKnowledge(readLineage(next, stableAgentId))).toBe(true);
  });
});

describe('MR-T13: at most five receptionists', () => {
  it('refuses the sixth with the limit message and adds nothing', async () => {
    const who = await world();
    for (const name of ['Amy', 'Ben', 'Cy', 'Di']) expect((await create(who, { name })).status).toBe(201);
    expect(await list(who)).toHaveLength(RECEPTIONIST_LIMIT);

    const sixth = await create(who, { name: 'Eve' });
    expect([sixth.status, sixth.body.title, sixth.body.detail]).toEqual([409, 'receptionist_limit', 'You can have up to 5 receptionists.']);
    expect(RECEPTIONIST_LIMIT_MESSAGE).toBe('You can have up to 5 receptionists.');
    // A full business answers the same whatever name was typed.
    expect((await create(who, { name: 'Amy' })).body.title).toBe('receptionist_limit');
    expect((await create(who, {})).body.title).toBe('receptionist_limit');
    expect(await list(who)).toHaveLength(5);
    expect(await targetRows(who.owner.scopeId)).toHaveLength(5);
    expect(Object.keys((await scopeState(ctx.pg, who.owner.scopeId)).agentLineages)).toHaveLength(5);
  });

  it('counts each business on its own', async () => {
    const full = await world();
    for (const name of ['Amy', 'Ben', 'Cy', 'Di']) await create(full, { name });
    const other = await world();
    expect((await create(other, { name: 'Amy' })).status).toBe(201);
    expect((await create(full, { name: 'Eve' })).status).toBe(409);
  });

  it('enforces the limit in the SQL function itself', async () => {
    const who = await world();
    const session = (await ctx.ownerSql('SELECT secret_hash FROM frontline_auth_sessions WHERE provider_subject = $1', [who.owner.subject])).rows[0].secret_hash;
    const register = () => ctx.pg.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [who.owner.scopeId]);
      return (await tx.query('SELECT register_frontline_claimed_agent($1,$2::uuid,$3::uuid) AS count', [session, who.owner.scopeId, randomUUID()])).rows[0].count;
    });
    expect([await register(), await register(), await register(), await register()]).toEqual([2, 3, 4, 5]);
    await expect(register()).rejects.toThrow('receptionist_limit');
    expect(await targetRows(who.owner.scopeId)).toHaveLength(5);
  });
});

describe('MR-T14: another owner cannot reach the new receptionist', () => {
  it('reads, renames, pauses, tests, shares and adds to nothing of another business', async () => {
    const mine = await world();
    const theirs = await world();
    const made = (await create(mine, { name: 'Sam' })).body;
    const id = made.stableAgentId;
    const attempts = [
      ['GET', at(id, '/summary')], ['GET', at(id, '/knowledge')], ['GET', at(id, '/conversations')], ['GET', at(id, '/shares')],
      ['PATCH', at(id, '/name'), { name: 'Hacked' }], ['POST', at(id, '/pause'), {}], ['POST', at(id, '/resume'), {}],
      ['POST', at(id, '/tests'), { expectedAgentVersionId: id }], ['POST', at(id, '/shares'), { expectedAgentVersionId: id }],
      ['PUT', at(id, '/knowledge-sources-selection'), { sourceIds: [], expectedAgentVersionId: id }],
    ];
    for (const [method, path, body] of attempts) {
      const result = await call(theirs.client, method, path, body, method === 'POST' ? randomUUID() : undefined);
      expect([method, path, result.status]).toEqual([method, path, 404]);
    }
    // Their own home never lists it, and their create cannot be aimed at my business.
    expect((await list(theirs)).map((agent) => agent.stableAgentId)).toEqual([theirs.owner.agentId]);
    const aimed = await create(theirs, { name: 'Intruder', siblingAgentId: id });
    expect(aimed.status).toBe(404);
    const own = await create(theirs, { name: 'Intruder' });
    expect(own.status).toBe(201);
    expect((await list(mine)).map((agent) => agent.name)).toEqual(['Blake', 'Sam']);
    expect((await list(theirs)).map((agent) => agent.name)).toEqual(['Blake', 'Intruder']);
    expect((await scopeState(ctx.pg, mine.owner.scopeId)).agentLineages[id].name).toBe('Sam');
    expect(await targetRows(theirs.owner.scopeId)).toHaveLength(2);
    // Nothing changed for me.
    expect((await call(mine.client, 'GET', at(id, '/summary'))).body).toMatchObject({ name: 'Sam', status: 'active' });
  });

  it('refuses a signed-out caller, and a caller with no claimed receptionist', async () => {
    const who = await world();
    const signedOut = browserClient(ctx.app, null);
    expect((await create(who, { name: 'Sam' }, randomUUID(), signedOut)).status).toBe(401);
    const { authToken } = await asOwner(ctx.pg, async () => {
      const token = 'c'.repeat(64);
      const subject = `google:${randomUUID().slice(0, 12)}`;
      await ctx.pg.query("INSERT INTO frontline_auth_sessions(secret_hash, provider_subject, provider_session_id, expires_at) VALUES (encode(sha256(convert_to($1,'UTF8')),'hex'),$2,'google-oidc', now() + interval '1 hour')", [token, subject]);
      return { authToken: token };
    });
    expect((await create(who, { name: 'Sam' }, randomUUID(), browserClient(ctx.app, authToken))).status).toBe(404);
  });

  it('gives a member of the business the same access as its other owner screens', async () => {
    const who = await world();
    const made = (await create(who, { name: 'Sam' })).body;
    const other = await asOwner(ctx.pg, async () => {
      const authToken = 'd'.repeat(64);
      await ctx.pg.query("INSERT INTO frontline_auth_sessions(secret_hash, provider_subject, provider_session_id, expires_at) VALUES (encode(sha256(convert_to($1,'UTF8')),'hex'),$2,'google-oidc', now() + interval '1 hour')", [authToken, 'google:sibling-session']);
      await ctx.pg.query("INSERT INTO frontline_memberships(tenant_id, provider_subject, role) VALUES ($1,$2,'member')", [who.owner.tenant, 'google:sibling-session']);
      return browserClient(ctx.app, authToken);
    });
    expect((await call(other, 'GET', at(made.stableAgentId, '/summary'))).status).toBe(200);
  });
});

describe('MR-T16: a receptionist with no selected source takes no calls', () => {
  it('refuses test start, share create, guest start and Resume with the needs-knowledge reason, and allows them again after a source is selected', async () => {
    const who = await world();
    const id = (await create(who, { name: 'Sam' })).body.stableAgentId;
    // A link made and opened while a source was selected.
    const cookie = await openLinkFor(who, id);

    const emptied = await select(who, id, [], id);
    expect(emptied.status).toBe(200);
    expect(emptied.body.sourceIds).toEqual([]);
    const emptyVersion = emptied.body.currentAgentVersionId;
    expect((await agentOf(who, id))).toMatchObject({ needsKnowledge: true, status: 'active' });

    expect(problemOf(await startTest(who, id, emptyVersion))).toEqual(NEEDS_KNOWLEDGE('Sam'));
    expect(problemOf(await share(who, id, emptyVersion))).toEqual(NEEDS_KNOWLEDGE('Sam'));
    const guest = await ctx.guestPost('/v1/shared/start', cookie);
    expect(problemOf({ status: guest.status, body: await guest.json() })).toEqual(NEEDS_KNOWLEDGE('Sam'));
    // The refused starts reserved nothing: no call, and the link is still unused.
    expect(Object.values((await scopeState(ctx.pg, who.owner.scopeId)).demos ?? {}).filter((demo) => demo.stableAgentId === id)).toEqual([]);
    expect((await ctx.ownerSql('SELECT status FROM frontline_share_grants WHERE stable_agent_id = $1', [id])).rows).toEqual([{ status: 'unused' }]);

    expect((await call(who.client, 'POST', at(id, '/pause'), {})).status).toBe(200);
    expect(problemOf(await call(who.client, 'POST', at(id, '/resume'), {}))).toEqual(NEEDS_KNOWLEDGE('Sam'));
    expect((await agentOf(who, id))).toMatchObject({ needsKnowledge: true, status: 'paused' });

    // Selecting a source with the selection endpoint makes each one available again.
    const back = await select(who, id, [SOURCE], emptyVersion);
    expect(back.status).toBe(200);
    const version = back.body.currentAgentVersionId;
    expect((await call(who.client, 'POST', at(id, '/resume'), {})).body.status).toBe('active');
    expect((await agentOf(who, id))).toMatchObject({ needsKnowledge: false, status: 'active' });
    const started = await startTest(who, id, version);
    expect(started.status).toBe(201);
    expect((await call(who.client, 'POST', at(id, `/tests/${started.body.demoId}/end`))).status).toBe(200);
    expect((await share(who, id, version)).status).toBe(201);
    const guestCookie = await openLinkFor(who, id, version);
    expect((await ctx.guestPost('/v1/shared/start', guestCookie)).status).toBe(201);
    expect((await ctx.guestPost('/v1/shared/end', guestCookie)).status).toBe(200);
  });

  it('refuses everything for a receptionist created with nothing selected, with its own name in the reason', async () => {
    const who = await world();
    const knowledge = await knowledgeOf(who, who.owner.agentId);
    await call(who.client, 'POST', at(who.owner.agentId, `/knowledge-sources/${SOURCE}/erase`), { confirm: true, expectedPointerGeneration: knowledge.pointerGeneration });
    await ctx.api.postOnboardingIdle();
    const made = (await create(who, { name: 'Zoë' })).body;
    expect(made.needsKnowledge).toBe(true);
    expect(problemOf(await startTest(who, made.stableAgentId))).toEqual(NEEDS_KNOWLEDGE('Zoë'));
    expect(problemOf(await share(who, made.stableAgentId))).toEqual(NEEDS_KNOWLEDGE('Zoë'));
    await call(who.client, 'POST', at(made.stableAgentId, '/pause'), {});
    expect(problemOf(await call(who.client, 'POST', at(made.stableAgentId, '/resume'), {}))).toEqual(NEEDS_KNOWLEDGE('Zoë'));
  });

  it('reads a receptionist without a stored selection as having knowledge', () => {
    expect(needsKnowledge({})).toBe(false);
    expect(needsKnowledge({ sourceIds: undefined })).toBe(false);
    expect(needsKnowledge(null)).toBe(false);
    expect(needsKnowledge({ sourceIds: [] })).toBe(true);
    expect(needsKnowledge({ sourceIds: ['a'] })).toBe(false);
    expect(hasSelectedKnowledge({}, { sourceIds: [] })).toBe(false);
  });

  it('keeps the existing first receptionist unchanged: no needs-knowledge flag and calls allowed', async () => {
    const who = await world();
    expect((await list(who))[0]).toMatchObject({ needsKnowledge: false });
    const started = await startTest(who, who.owner.agentId);
    expect(started.status).toBe(201);
    expect((await call(who.client, 'POST', at(who.owner.agentId, `/tests/${started.body.demoId}/end`))).status).toBe(200);
    expect((await share(who, who.owner.agentId)).status).toBe(201);
  });
});

describe('idempotent create', () => {
  it('returns the same receptionist for the same key and adds no duplicate', async () => {
    const who = await world();
    const key = randomUUID();
    const first = await create(who, { name: 'Sam' }, key);
    const second = await create(who, { name: 'Sam' }, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(second.body.stableAgentId).toBe(first.body.stableAgentId);
    expect(second.body).toMatchObject({ name: 'Sam', versionNumber: 1 });
    expect(await list(who)).toHaveLength(2);
    expect(await targetRows(who.owner.scopeId)).toHaveLength(2);
    expect(Object.keys((await scopeState(ctx.pg, who.owner.scopeId)).agentLineages)).toHaveLength(2);
  });

  it('answers a retry with the receptionist even after the business is full, and after a rename', async () => {
    const who = await world();
    const key = randomUUID();
    const first = await create(who, { name: 'Sam' }, key);
    for (const name of ['Ben', 'Cy', 'Di']) await create(who, { name });
    expect((await create(who, { name: 'Eve' })).status).toBe(409);
    expect((await call(who.client, 'PATCH', at(first.body.stableAgentId, '/name'), { name: 'Samuel' })).status).toBe(200);
    const retried = await create(who, { name: 'Sam' }, key);
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ stableAgentId: first.body.stableAgentId, name: 'Samuel' });
    expect(await list(who)).toHaveLength(5);
  });

  it('refuses the same key with a different name', async () => {
    const who = await world();
    const key = randomUUID();
    expect((await create(who, { name: 'Sam' }, key)).status).toBe(201);
    const conflict = await create(who, { name: 'Ava' }, key);
    expect([conflict.status, conflict.body.title]).toEqual([409, 'idempotency_conflict']);
    expect(await list(who)).toHaveLength(2);
  });

  it('requires a key and a well-formed body', async () => {
    const who = await world();
    const noKey = await call(who.client, 'POST', '/v1/me/agents', { name: 'Sam' });
    expect([noKey.status, noKey.body.title]).toEqual([400, 'invalid_field']);
    expect((await call(who.client, 'POST', '/v1/me/agents', { name: 'Sam' }, 'bad key!')).status).toBe(400);
    expect((await create(who, { name: 'Sam', color: 'red' })).status).toBe(400);
    expect((await create(who, { name: 'Sam', siblingAgentId: 'not-an-id' })).status).toBe(400);
    expect((await create(who, ['Sam'])).status).toBe(400);
    const noCsrf = await ctx.app.fetch(`${ctx.app.baseUrl}/v1/me/agents`, { method: 'POST', headers: { origin: ctx.app.baseUrl, cookie: `fl_auth=${who.owner.authToken}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{"name":"Sam"}' });
    expect(noCsrf.status).toBe(403);
    expect(await list(who)).toHaveLength(1);
  });

  it('adds next to the named receptionist when a person has several businesses', async () => {
    const first = await world({ subject: 'google:two-businesses' });
    const second = await world({ subject: 'google:two-businesses' });
    const both = await list(first);
    expect(both.map((agent) => agent.stableAgentId)).toEqual([first.owner.agentId, second.owner.agentId]);
    const made = await create(first, { name: 'Sam', siblingAgentId: second.owner.agentId });
    expect(made.status).toBe(201);
    expect((await targetRows(second.owner.scopeId)).map((row) => row.target_id)).toEqual([second.owner.agentId, made.body.stableAgentId]);
    expect(await targetRows(first.owner.scopeId)).toHaveLength(1);
    const plain = await create(first, { name: 'Ann' });
    expect((await targetRows(first.owner.scopeId)).map((row) => row.target_id)).toEqual([first.owner.agentId, plain.body.stableAgentId]);
    // Names are unique inside one business, not across a person's businesses.
    expect((await create(first, { name: 'Sam' })).status).toBe(201);
  });
});

describe('several receptionists, several targets', () => {
  it('shows a person\'s owner test result in any of their businesses whatever the target cookie names', async () => {
    const first = await world({ subject: 'google:target-hint' });
    const second = await world({ subject: 'google:target-hint' });
    const made = (await create(second, { name: 'Sam', siblingAgentId: second.owner.agentId })).body;
    expect((await targetRows(second.owner.scopeId)).map((row) => row.target_id)).toEqual([second.owner.agentId, made.stableAgentId]);
    const started = await startTest(first, made.stableAgentId);
    expect(started.status).toBe(201);
    expect((await call(first.client, 'POST', at(made.stableAgentId, `/tests/${started.body.demoId}/end`))).status).toBe(200);
    // The fixture state has no anonymous-demo request map, which the result route reads.
    await ctx.ownerSql("UPDATE scoped_workspace_states SET state = state || '{\"requests\": {}}'::jsonb WHERE owner_scope_id = $1", [second.owner.scopeId]);
    const read = (hint) => ctx.app.fetch(`${ctx.app.baseUrl}/v1/demos/${started.body.demoId}/result`, {
      headers: { origin: ctx.app.baseUrl, cookie: `fl_auth=${first.owner.authToken}; fl_csrf=${first.client.csrf}${hint ? `; fl_owner_target=${hint}` : ''}`, 'x-frontline-csrf': first.client.csrf },
    });
    // The cookie names the first business's receptionist, and the test ran in the second business.
    for (const hint of [`agent.${first.owner.agentId}`, `agent.${second.owner.agentId}`, `agent.${made.stableAgentId}`, null]) {
      const response = await read(hint);
      expect([hint, response.status]).toEqual([hint, 200]);
      expect((await response.json()).demoId).toBe(started.body.demoId);
    }
    // A stranger with a cookie naming their own receptionist still cannot read it.
    const stranger = await world();
    const denied = await ctx.app.fetch(`${ctx.app.baseUrl}/v1/demos/${started.body.demoId}/result`, {
      headers: { origin: ctx.app.baseUrl, cookie: `fl_auth=${stranger.owner.authToken}; fl_csrf=${stranger.client.csrf}; fl_owner_target=agent.${stranger.owner.agentId}`, 'x-frontline-csrf': stranger.client.csrf },
    });
    expect([401, 404]).toContain(denied.status);
    expect((await denied.json()).mode).toBeUndefined();
  });

  it('keeps every receptionist\'s setup separate', async () => {
    const who = await world();
    const made = (await create(who, { name: 'Sam' })).body;
    const bobSetup = (await call(who.client, 'GET', `/v1/agents/${who.owner.agentId}`)).body;
    const samSetup = (await call(who.client, 'GET', `/v1/agents/${made.stableAgentId}`)).body;
    expect(bobSetup.agentId).toBe(who.owner.agentId);
    expect(samSetup.agentId).toBe(made.stableAgentId);
    const saved = await call(who.client, 'PATCH', `/v1/agents/${made.stableAgentId}/setup`, { expectedVersion: samSetup.setupVersion, selectedCapabilityIds: [], missingContext: 'Closed Sundays.' });
    expect(saved.status).toBe(200);
    expect((await call(who.client, 'GET', `/v1/agents/${who.owner.agentId}`)).body.setup.missingContext).toBe(bobSetup.setup.missingContext);
  });
});

describe('migration 017 and its rollback', () => {
  const rollback = () => withoutOuterTransaction(readFileSync(new URL('../../migrations/rollback/017_receptionist_create.down.sql', import.meta.url), 'utf8'));
  const forward = () => withoutOuterTransaction(readFileSync(new URL('../../migrations/017_receptionist_create.sql', import.meta.url), 'utf8'));
  const routines = async (pg) => (await pg.query("SELECT proname FROM pg_proc WHERE proname = 'register_frontline_claimed_agent'")).rows.length;
  const column = async (pg) => (await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'frontline_claimed_targets' AND column_name = 'created_at'")).rows.length;

  it('applies on the real chain, and the runtime role can run the function but not touch the table', async () => {
    const pg = await createMigratedDatabase();
    expect([await routines(pg), await column(pg)]).toEqual([1, 1]);
    await pg.exec('SET ROLE frontline_app');
    await expect(pg.query('SELECT * FROM frontline_claimed_targets')).rejects.toThrow(/permission denied/);
    await expect(pg.query("SELECT register_frontline_claimed_agent(repeat('a',64), gen_random_uuid(), gen_random_uuid())")).rejects.toThrow('owner scope mismatch');
    await pg.exec('RESET ROLE');
    const cleanup = (await pg.query("SELECT has_function_privilege('frontline_cleanup', 'register_frontline_claimed_agent(text,uuid,uuid)', 'EXECUTE') AS allowed")).rows[0];
    expect(cleanup.allowed).toBe(false);
  });

  it('is safe to apply again and leaves rows and the listing as they were', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg, { researched: true });
    await pg.exec('RESET ROLE');
    const before = (await pg.query('SELECT target_id, created_at FROM frontline_claimed_targets')).rows;
    await pg.exec(forward());
    await pg.exec(forward());
    expect((await pg.query('SELECT target_id, created_at FROM frontline_claimed_targets')).rows).toEqual(before);
    await pg.exec('SET ROLE frontline_app');
    expect((await pg.query('SELECT target_id FROM list_frontline_claimed_targets($1)', [hash(owner.authToken)])).rows).toEqual([{ target_id: owner.agentId }]);
  });

  it('rolls back to the earlier listing and function set, keeping targets and scope content, and repeats safely', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg, { researched: true });
    await pg.exec('RESET ROLE');
    const stateBefore = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
    await pg.exec(rollback());
    await pg.exec(rollback());
    expect([await routines(pg), await column(pg)]).toEqual([0, 0]);
    expect((await pg.query('SELECT target_id FROM frontline_claimed_targets')).rows).toEqual([{ target_id: owner.agentId }]);
    expect((await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state).toEqual(stateBefore);
    await pg.exec('SET ROLE frontline_app');
    expect((await pg.query('SELECT target_id FROM list_frontline_claimed_targets($1)', [hash(owner.authToken)])).rows).toEqual([{ target_id: owner.agentId }]);
    await pg.exec('RESET ROLE');
    await pg.exec(forward());
    expect([await routines(pg), await column(pg)]).toEqual([1, 1]);
  });

  it('refuses a session that is not a member of the scope, a revoked session and a scope other than the caller\'s setting', async () => {
    const pg = await createMigratedDatabase();
    const owner = await seedClaimedOwner(pg, { researched: true });
    const stranger = await seedClaimedOwner(pg, { researched: true });
    await pg.exec('RESET ROLE');
    await pg.query('UPDATE frontline_auth_sessions SET revoked_at = now() WHERE provider_subject = $1', [stranger.subject]);
    await pg.exec('SET ROLE frontline_app');
    const register = (token, scope, setting = scope) => pg.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [setting]);
      return tx.query('SELECT register_frontline_claimed_agent($1,$2::uuid,$3::uuid)', [hash(token), scope, randomUUID()]);
    });
    await expect(register(stranger.authToken, owner.scopeId)).rejects.toThrow('not_found');
    await expect(register(stranger.authToken, stranger.scopeId)).rejects.toThrow('not_found');
    await expect(register(owner.authToken, owner.scopeId, stranger.scopeId)).rejects.toThrow('owner scope mismatch');
    await expect(register(owner.authToken, owner.scopeId)).resolves.toBeTruthy();
  });
});
