import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNameFree, parseReceptionistName, receptionistNameOf } from '../../server/api/post-onboarding/receptionist-name.js';
import { startConnectedApi } from './connected-api.js';
import { asOwner, browserClient, seedClaimedOwner } from './fixtures.js';

// MR-T5 and MR-T6 (multi-receptionist spec MR-D4): the receptionist's name lives on the lineage, is validated and unique,
// reaches every owner summary and the runtime bundle of each call that starts after it, and never creates a version.
let ctx; let stranger; let strangerClient;
beforeAll(async () => {
  ctx = await startConnectedApi();
  stranger = await seedClaimedOwner(ctx.pg, { researched: true });
  strangerClient = browserClient(ctx.app, stranger.authToken);
});
afterAll(() => ctx?.restore());

const agentPath = () => `/v1/agents/${ctx.owner.agentId}`;
const rename = async (name, client = ctx.ownerClient, path = `${agentPath()}/name`) => { const response = await client.request('PATCH', path, { body: { name } }); return { status: response.status, body: await response.json() }; };
const summary = async () => (await ctx.ownerClient.request('GET', `${agentPath()}/summary`)).json();
const runtime = async (demo) => (await (await ctx.workerCall(demo, 'runtime', {}, {}, 'GET')).json());
const stateOf = () => ctx.ownerSql('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [ctx.owner.scopeId]).then((result) => result.rows[0].state);

describe('validation (MR-T6)', () => {
  it('trims and accepts letters, accented letters, spaces, apostrophes and hyphens', () => {
    expect(parseReceptionistName('  Sam  ')).toBe('Sam');
    expect(parseReceptionistName('Mary   Ann')).toBe('Mary Ann');
    expect(parseReceptionistName("D'Arcy")).toBe("D'Arcy");
    expect(parseReceptionistName('Jean-Luc')).toBe('Jean-Luc');
    expect(parseReceptionistName('Zoë')).toBe('Zoë');
    expect(parseReceptionistName('José María')).toBe('José María');
    expect(parseReceptionistName('x'.repeat(30))).toHaveLength(30);
    expect(parseReceptionistName('é')).toBe('é');
  });

  it.each([
    ['empty', ''], ['spaces only', '    '], ['31 characters', 'x'.repeat(31)], ['digits only', '12345'], ['symbols only', '!!!'],
    ['punctuation only', "'-'"], ['letters with digits', 'Sam2'], ['markup', '<b>Sam</b>'], ['a line break', 'Sam\nJones'], ['an emoji', 'Sam 🙂'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseReceptionistName(value)).toThrowError(expect.objectContaining({ status: 422, code: 'invalid_name' }));
  });

  it('rejects a missing or non-text name as a bad field', () => {
    for (const value of [undefined, null, 7, ['Sam'], { name: 'Sam' }]) expect(() => parseReceptionistName(value)).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_field' }));
  });

  it('treats a lineage with no name as Blake when checking for duplicates', () => {
    const state = { agentLineages: { first: { stableAgentId: 'first' }, second: { stableAgentId: 'second', name: 'Sam' } } };
    expect(receptionistNameOf(state.agentLineages.first)).toBe('Blake');
    expect(() => assertNameFree(state, 'second', 'blake')).toThrowError(expect.objectContaining({ status: 409, code: 'name_taken' }));
    expect(() => assertNameFree(state, 'first', 'sAM')).toThrowError(expect.objectContaining({ code: 'name_taken' }));
    expect(() => assertNameFree(state, 'second', 'Sam')).not.toThrow();
    expect(() => assertNameFree(state, 'first', 'Riley')).not.toThrow();
  });
});

describe('PATCH /v1/agents/:id/name', () => {
  it('reads as Blake before any rename, and the name is on the owner summaries', async () => {
    expect((await summary()).name).toBe('Blake');
    expect((await (await ctx.ownerClient.request('GET', '/v1/me/agents')).json()).agents[0].name).toBe('Blake');
  });

  it('renames on the lineage, shows the name on every owner summary and creates no version (MR-T5)', async () => {
    const before = await summary();
    const { status, body } = await rename('  Sam ');
    expect(status).toBe(200);
    expect(body).toMatchObject({ stableAgentId: ctx.owner.agentId, name: 'Sam' });
    const after = await summary();
    expect(after).toMatchObject({ name: 'Sam', currentAgentVersionId: before.currentAgentVersionId, pointerGeneration: before.pointerGeneration, versionNumber: before.versionNumber });
    expect((await (await ctx.ownerClient.request('GET', '/v1/me/agents')).json()).agents[0]).toMatchObject({ name: 'Sam', currentAgentVersionId: before.currentAgentVersionId });
    const lineage = (await stateOf()).agentLineages[ctx.owner.agentId];
    expect(lineage.name).toBe('Sam');
    expect(lineage.revisions).toHaveLength(before.knownVersionIds.length);
    expect(Object.keys((await stateOf()).agents)).toHaveLength(before.knownVersionIds.length);
  });

  it('is safe to send again, and to change back to Blake', async () => {
    expect((await rename('Sam')).status).toBe(200);
    expect((await rename('Sam')).body.name).toBe('Sam');
    expect((await rename('blake')).body.name).toBe('blake');
    expect((await summary()).name).toBe('blake');
    expect((await rename('Blake')).body.name).toBe('Blake');
    expect((await summary()).name).toBe('Blake');
    expect((await rename('Sam')).body.name).toBe('Sam');
  });

  it('refuses invalid names with the plain reason and changes nothing (MR-T6)', async () => {
    for (const name of ['', '   ', 'x'.repeat(31), '12345', '!!!', 'Sam2']) {
      const { status, body } = await rename(name);
      expect(status, name).toBe(422);
      expect(body).toMatchObject({ title: 'invalid_name', detail: 'Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.' });
    }
    expect((await rename(undefined)).status).toBe(400);
    expect((await ctx.ownerClient.request('PATCH', `${agentPath()}/name`, { body: ['Sam'] })).status).toBe(400);
    expect((await summary()).name).toBe('Sam');
  });

  it('refuses a name another receptionist in the business already uses, ignoring case, but allows its own name in any case (MR-T6)', async () => {
    const state = await stateOf();
    const otherId = randomUUID();
    state.agentLineages[otherId] = { ...state.agentLineages[ctx.owner.agentId], stableAgentId: otherId, name: 'Riley' };
    await ctx.ownerSql('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [ctx.owner.scopeId, JSON.stringify(state)]);
    for (const name of ['Riley', 'riley', 'RILEY', ' rIlEy ']) {
      const { status, body } = await rename(name);
      expect(status, name).toBe(409);
      expect(body).toMatchObject({ title: 'name_taken', detail: 'That name is already used.' });
    }
    expect((await summary()).name).toBe('Sam');
    expect((await rename('SAM')).status).toBe(200);
    expect((await summary()).name).toBe('SAM');
    const restored = await stateOf();
    delete restored.agentLineages[otherId];
    await ctx.ownerSql('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [ctx.owner.scopeId, JSON.stringify(restored)]);
    expect((await rename('Sam')).status).toBe(200);
  });

  it('does not let another owner rename, or read the name of, someone else\'s receptionist (MR-T6, MR-T14)', async () => {
    const { status } = await rename('Hijacked', strangerClient);
    expect(status).toBe(404);
    expect((await summary()).name).toBe('Sam');
    expect((await strangerClient.request('GET', `${agentPath()}/summary`)).status).toBe(404);
    const mine = await rename('Riley', strangerClient, `/v1/agents/${stranger.agentId}/name`);
    expect(mine.status).toBe(200);
    // The same name in two different businesses is fine.
    expect((await rename('Riley')).status).toBe(200);
    expect((await rename('Sam')).status).toBe(200);
  });

  it('needs a signed-in session and the CSRF pair, and answers 404 for other methods', async () => {
    expect((await rename('Sam', browserClient(ctx.app, null))).status).toBe(404);
    const noCsrf = await ctx.app.fetch(`${ctx.app.baseUrl}${agentPath()}/name`, { method: 'PATCH', headers: { origin: ctx.app.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sam' }) });
    expect(noCsrf.status).toBe(403);
    expect((await ctx.ownerClient.request('GET', `${agentPath()}/name`)).status).toBe(404);
    expect((await ctx.ownerClient.request('DELETE', `${agentPath()}/name`)).status).toBe(404);
  });
});

describe('the name a call starts with (MR-T6)', () => {
  it('goes into the runtime bundle when the call starts, and a call already running keeps its name', async () => {
    await rename('Sam');
    const before = await ctx.startOwnerTest();
    expect((await runtime(before)).receptionistName).toBe('Sam');
    expect((await rename('Riley')).status).toBe(200);
    // The running call still reads its own name, even when the worker fetches the bundle again after a reconnect.
    expect((await runtime(before)).receptionistName).toBe('Sam');
    await ctx.ownerClient.request('POST', `${agentPath()}/tests/${before.id}/end`);
    const after = await ctx.startOwnerTest();
    expect((await runtime(after)).receptionistName).toBe('Riley');
    expect((await ctx.demoRecord(after.id)).receptionistName).toBe('Riley');
    await ctx.ownerClient.request('POST', `${agentPath()}/tests/${after.id}/end`);
  });

  it('gives a shared guest call the name from when it started', async () => {
    await rename('Jordan');
    const { demo } = await ctx.startGuestCall();
    expect((await runtime(demo)).receptionistName).toBe('Jordan');
    await rename('Sam');
    expect((await runtime(demo)).receptionistName).toBe('Jordan');
  });

  it('is Blake for a receptionist that was never renamed and for a call recorded before names existed', async () => {
    const fresh = await startConnectedApi();
    try {
      const demo = await fresh.startOwnerTest();
      expect((await (await fresh.workerCall(demo, 'runtime', {}, {}, 'GET')).json()).receptionistName).toBe('Blake');
      await fresh.ownerSql("UPDATE scoped_workspace_states SET state = state #- $2::text[] WHERE owner_scope_id = $1", [fresh.owner.scopeId, ['demos', demo.id, 'receptionistName']]);
      expect((await (await fresh.workerCall(demo, 'runtime', {}, {}, 'GET')).json()).receptionistName).toBe('Blake');
    } finally { fresh.restore(); }
  });

  it('uses the name in the messages the owner reads', async () => {
    await rename('Sam');
    const stale = await ctx.ownerClient.request('POST', `${agentPath()}/shares`, { body: { expectedAgentVersionId: randomUUID() } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).detail).toBe('Sam changed while this page was open. Reload to share the latest version.');
    const staleTest = await ctx.ownerClient.request('POST', `${agentPath()}/tests`, { body: { expectedAgentVersionId: randomUUID() } });
    expect((await staleTest.json()).detail).toBe('Sam changed since you opened this. Refresh and try again.');
    const capabilities = await (await ctx.ownerClient.request('GET', `${agentPath()}/capabilities`)).json();
    const notes = capabilities.workflows.map((workflow) => workflow.note).filter(Boolean).join(' ');
    expect(notes).toContain('Sam');
    expect(notes).not.toContain('Blake');
  });
});

describe('the guest link page', () => {
  it('names the receptionist the guest will talk to', async () => {
    await rename('Alex');
    const view = await summary();
    const share = await (await ctx.ownerClient.request('POST', `${agentPath()}/shares`, { body: { expectedAgentVersionId: view.currentAgentVersionId } })).json();
    const opened = await ctx.app.fetch(`${ctx.app.baseUrl}/v1/shared/exchange`, { method: 'POST', headers: { origin: ctx.app.baseUrl, 'x-frontline-guest': '1', 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(share.url).hash.replace('#t=', '') }) });
    expect(await opened.json()).toMatchObject({ receptionistName: 'Alex', agentIdentity: 'Alex, an AI assistant for Riverside Dental' });
  });
});

describe('storage', () => {
  it('keeps the name when the first rename happens on a lineage that was never stored', async () => {
    const fresh = await startConnectedApi();
    try {
      await asOwner(fresh.pg, async () => {
        const state = (await fresh.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [fresh.owner.scopeId])).rows[0].state;
        delete state.agentLineages;
        await fresh.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [fresh.owner.scopeId, JSON.stringify(state)]);
      });
      const response = await fresh.ownerClient.request('PATCH', `/v1/agents/${fresh.owner.agentId}/name`, { body: { name: 'Sam' } });
      expect(response.status).toBe(200);
      const summaryNow = await (await fresh.ownerClient.request('GET', `/v1/agents/${fresh.owner.agentId}/summary`)).json();
      expect(summaryNow).toMatchObject({ name: 'Sam', versionNumber: 1, pointerGeneration: 1, currentAgentVersionId: fresh.owner.agentId });
    } finally { fresh.restore(); }
  });
});
