import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, hex64, seedClaimedOwner, startServer } from './fixtures.js';

let pg; let app; let subject; let first; let second; let client; let stranger; let strangerClient;
const json = async (response) => ({ status: response.status, body: await response.json() });
const stateOf = (scopeId) => asOwner(pg, async () => (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId])).rows[0].state);

/** An unfinished workspace: a claimed workspace target for the same person, with no agent yet. */
async function addWorkspaceTarget(person) {
  await asOwner(pg, async () => {
    const scopeId = randomUUID(); const workspaceId = randomUUID();
    const tenant = (await pg.query('INSERT INTO frontline_tenants DEFAULT VALUES RETURNING id')).rows[0].id;
    await pg.query("INSERT INTO ownership_scopes(id, kind, secret_hash, state, expires_at, tenant_id) VALUES ($1,'tenant',$2,'claimed',NULL,$3)", [scopeId, hex64(), tenant]);
    await pg.query("INSERT INTO frontline_memberships(tenant_id, provider_subject, role) VALUES ($1,$2,'owner')", [tenant, person]);
    await pg.query("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('workspace',$1,$2,$3)", [workspaceId, scopeId, tenant]);
    await pg.query('INSERT INTO scoped_workspace_states(owner_scope_id, state) VALUES ($1,$2::jsonb)', [scopeId, JSON.stringify({ workspaces: { [workspaceId]: { id: workspaceId, businessName: 'Half Done Plumbing' } }, agents: {}, demos: {} })]);
  });
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  subject = `google:${randomUUID().slice(0, 12)}`;
  first = await seedClaimedOwner(pg, { subject, researched: true });
  await addWorkspaceTarget(subject);
  second = await seedClaimedOwner(pg, { subject, researched: true });
  stranger = await seedClaimedOwner(pg, { researched: true });
  await pg.exec('SET ROLE frontline_app');
  app = startServer(pg, { limits: { ownerWrite: 10_000, ownerRead: 10_000 } });
  client = browserClient(app, first.authToken);
  strangerClient = browserClient(app, stranger.authToken);
});
afterAll(async () => { await app?.close(); });

describe('GET /v1/me/agents', () => {
  it('lists every claimed target of the signed-in person in creation order, and only theirs', async () => {
    const { status, body } = await json(await client.request('GET', '/v1/me/agents'));
    expect(status).toBe(200);
    expect(body.agents.map((agent) => [agent.kind, agent.stableAgentId])).toEqual([['agent', first.agentId], ['workspace', expect.any(String)], ['agent', second.agentId]]);
    expect(body.agents[0]).toMatchObject({ businessName: 'Riverside Dental', currentAgentVersionId: first.agentId, knowledgeState: 'ready', lastTestedAt: null, ownerReviewedAt: null, untestedChanges: false });
    expect(body.agents[1]).toMatchObject({ businessName: 'Half Done Plumbing', currentAgentVersionId: null, knowledgeState: 'unavailable' });
    const others = (await json(await strangerClient.request('GET', '/v1/me/agents'))).body.agents;
    expect(others.map((agent) => agent.stableAgentId)).toEqual([stranger.agentId]);
    expect(JSON.stringify(body)).not.toContain('PRIVATE-KNOWLEDGE-SENTINEL');
    expect(JSON.stringify(body)).not.toContain(first.scopeId);
  });

  it('needs a signed-in session', async () => {
    expect((await json(await browserClient(app, null).request('GET', '/v1/me/agents'))).status).toBe(401);
    // A session that is unknown, expired or ended (sign-out elsewhere, account deletion) is asked to sign in again.
    expect((await json(await browserClient(app, hex64()).request('GET', '/v1/me/agents'))).status).toBe(401);
  });
});

describe('agent summary and knowledge state', () => {
  const summary = async (who, agentId) => json(await who.request('GET', `/v1/agents/${agentId}/summary`));

  it('reports version, test and review state, then untested changes after a publish', async () => {
    expect((await summary(client, first.agentId)).body).toMatchObject({ businessName: 'Riverside Dental', versionNumber: 1, pointerGeneration: 1, knowledgeState: 'ready', ready: true, voiceAvailable: false, currentVersionTestedAt: null, firstVisit: { seen: false, outcome: null } });
    const view = await (await client.request('GET', `/v1/agents/${first.agentId}/knowledge`)).json();
    const created = await json(await client.request('POST', `/v1/agents/${first.agentId}/knowledge-updates`, { body: { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: 1, op: 'add', group: 'faq', value: 'Do you take walk-ins? Yes.' }, headers: { 'idempotency-key': 'me-1' } }));
    const applied = await json(await client.request('POST', `/v1/agents/${first.agentId}/knowledge-updates/${created.body.update.updateId}/apply`, { body: { expectedVersion: 1, decisions: created.body.update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' })) }, headers: { 'idempotency-key': 'me-2' } }));
    const after = (await summary(client, first.agentId)).body;
    expect(after).toMatchObject({ versionNumber: 2, pointerGeneration: 2, currentAgentVersionId: applied.body.update.appliedAgentVersionId, knowledgeState: 'untested_changes', untestedChanges: true });
    const listed = (await json(await client.request('GET', '/v1/me/agents'))).body.agents[0];
    expect(listed).toMatchObject({ knowledgeState: 'untested_changes', versionNumber: 2 });

    const state = await stateOf(first.scopeId);
    state.agentLineages[first.agentId].revisions[1].lastTestedAt = '2026-09-26T12:00:00.000Z';
    await asOwner(pg, () => pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [first.scopeId, JSON.stringify(state)]));
    expect((await summary(client, first.agentId)).body).toMatchObject({ knowledgeState: 'ready', lastTestedAt: '2026-09-26T12:00:00.000Z', currentVersionTestedAt: '2026-09-26T12:00:00.000Z', untestedChanges: false });
  });

  it('shows Processing while an update is being read', async () => {
    const state = await stateOf(second.scopeId);
    state.knowledgeBases = { [second.agentId]: { entries: {}, sources: {}, retractions: [], updates: { u1: { updateId: 'u1', state: 'extracting', createdAt: '2026-09-26T12:00:00.000Z', leaseExpiresAt: '2099-01-01T00:00:00.000Z', candidates: [], version: 1 } }, materializedFromKnowledgeRevisionId: null } };
    await asOwner(pg, () => pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [second.scopeId, JSON.stringify(state)]));
    expect((await summary(client, second.agentId)).body.knowledgeState).toBe('processing');
  });

  it('is limited to the owner of the agent', async () => {
    expect((await summary(strangerClient, first.agentId)).status).toBe(404);
  });
});

describe('first visit', () => {
  it('records skip or continue once, never a rating, and only for the owner', async () => {
    const path = `/v1/agents/${second.agentId}/first-visit`;
    expect((await json(await client.request('POST', path, { body: { outcome: 'great' } }))).status).toBe(400);
    expect((await json(await strangerClient.request('POST', path, { body: { outcome: 'skipped' } }))).status).toBe(404);
    expect((await json(await client.request('POST', path, { body: { outcome: 'skipped' } }))).body).toMatchObject({ seen: true, outcome: 'skipped' });
    expect((await json(await client.request('POST', path, { body: { outcome: 'continued' } }))).body).toMatchObject({ seen: true, outcome: 'skipped' });
    const state = await stateOf(second.scopeId);
    expect(state.firstVisit[second.agentId]).toMatchObject({ outcome: 'skipped' });
    expect(Object.keys(state.firstVisit[second.agentId]).sort()).toEqual(['at', 'outcome']);
  });
});
