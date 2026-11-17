import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyUpdate, createFormUpdate, seedKnowledgeBase } from '../../server/api/post-onboarding/knowledge-model.js';
import { sourcesAddedBy } from '../../server/api/post-onboarding/knowledge-selection.js';
import { backfillKnowledgeLibrary, publishRevision, readKnowledgeBase, readLineage } from '../../server/api/post-onboarding/lineage.js';
import { startConnectedApi } from './connected-api.js';
import { asOwner, browserClient, RESEARCH_IDS, seedClaimedOwner } from './fixtures.js';
import { scopeState } from './ui-calls.js';

// MR-B3a (TOM-57): the business knowledge library and per-receptionist source selection. Pure rules first (backfill and
// snapshot equality, MR-T4), then the real handler on the migrated in-process Postgres (selection, MR-T3, isolation, erasure).
let ctx;
beforeAll(async () => { ctx = await startConnectedApi(); });
afterAll(() => ctx?.restore());

const NOW = new Date('2026-09-29T12:00:00.000Z');
const counter = () => { let count = 0; return () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`; };
const knowledgeOf = (state, stableAgentId) => state.knowledge[state.agents[readLineage(state, stableAgentId).currentAgentVersionId].knowledgeRevisionId];

describe('backfill into the business library', () => {
  const fresh = () => structuredClone(ctx.owner.state);

  it('moves the per-agent base into the library, selects all its sources and marks the onboarding website', () => {
    const state = { ...fresh(), knowledgeBases: { [ctx.owner.agentId]: seedKnowledgeBase(fresh().knowledge[fresh().agents[ctx.owner.agentId].knowledgeRevisionId]) } };
    // A base written before sources had an origin: the marker is inferred from the source type.
    for (const source of Object.values(state.knowledgeBases[ctx.owner.agentId].sources)) delete source.origin;
    const done = backfillKnowledgeLibrary(state, ctx.owner.agentId);
    expect(done.knowledgeBases).toBeUndefined();
    expect(Object.keys(done.knowledgeLibrary).sort()).toEqual(['entries', 'materializedFromKnowledgeRevisionId', 'retractions', 'sources', 'updates']);
    expect(Object.keys(done.knowledgeLibrary.entries)).toEqual(expect.arrayContaining([RESEARCH_IDS.service, RESEARCH_IDS.hours]));
    expect(done.knowledgeLibrary.sources['src-p1']).toMatchObject({ type: 'website', origin: 'onboarding_website' });
    expect(done.agentLineages[ctx.owner.agentId].sourceIds).toEqual(['src-p1']);
    expect(done.agentLineages[ctx.owner.agentId].currentAgentVersionId).toBe(ctx.owner.agentId);
  });

  it('seeds new websites with the origin and leaves other kinds of source without one', () => {
    const base = seedKnowledgeBase(fresh().knowledge[fresh().agents[ctx.owner.agentId].knowledgeRevisionId]);
    expect(base.sources['src-p1'].origin).toBe('onboarding_website');
  });

  it('is idempotent: a second run returns the same state, and a run on a read-only state adds nothing else', () => {
    const state = fresh();
    const once = backfillKnowledgeLibrary(state, ctx.owner.agentId);
    const twice = backfillKnowledgeLibrary(once, ctx.owner.agentId);
    expect(twice).toBe(once);
    expect(backfillKnowledgeLibrary(structuredClone(once), ctx.owner.agentId)).toEqual(once);
    expect(state.knowledgeLibrary).toBeUndefined();
  });

  it('keeps erased sources out of the selection and tolerates a base with missing parts', () => {
    const base = seedKnowledgeBase(fresh().knowledge[fresh().agents[ctx.owner.agentId].knowledgeRevisionId]);
    base.sources.gone = { sourceId: 'gone', type: 'owner_form', label: '', excerpt: '', erasedAt: '2026-09-01T00:00:00.000Z' };
    const done = backfillKnowledgeLibrary({ ...fresh(), knowledgeBases: { [ctx.owner.agentId]: base } }, ctx.owner.agentId);
    expect(done.agentLineages[ctx.owner.agentId].sourceIds).toEqual(['src-p1']);
    const malformed = backfillKnowledgeLibrary({ ...fresh(), knowledgeBases: { [ctx.owner.agentId]: { entries: { a: { value: 'x' } } } } }, ctx.owner.agentId);
    expect(malformed.agentLineages[ctx.owner.agentId].sourceIds).toEqual([]);
  });

  it('keeps bases of other receptionists apart in one library and leaves a base without a lineage alone', () => {
    const state = fresh();
    const other = 'other-agent';
    state.agents[other] = { ...state.agents[ctx.owner.agentId], id: other };
    const ownBase = seedKnowledgeBase(state.knowledge[state.agents[ctx.owner.agentId].knowledgeRevisionId]);
    const otherBase = structuredClone(ownBase);
    otherBase.sources.extra = { sourceId: 'extra', type: 'owner_form', label: 'Note', excerpt: '', erasedAt: null };
    const done = backfillKnowledgeLibrary({ ...state, knowledgeBases: { [ctx.owner.agentId]: ownBase, [other]: otherBase, orphan: ownBase } }, ctx.owner.agentId);
    expect(done.agentLineages[ctx.owner.agentId].sourceIds).toEqual(['src-p1']);
    expect(done.agentLineages[other].sourceIds.sort()).toEqual(['extra', 'src-p1']);
    expect(Object.keys(done.knowledgeBases)).toEqual(['orphan']);
  });
});

describe('MR-T4: the backfill leaves compiled knowledge byte-identical', () => {
  // Runs the same edits through the legacy path (per-agent base, lineage without sourceIds) and through the library path.
  function run(mode, edits) {
    const newId = counter();
    const id = ctx.owner.agentId;
    let state = structuredClone(ctx.owner.state);
    if (mode === 'library') state = backfillKnowledgeLibrary(state, id);
    const snapshots = [];
    for (const edit of edits) {
      const lineage = readLineage(state, id);
      const base = mode === 'library' ? state.knowledgeLibrary : (state.knowledgeBases?.[id] ?? seedKnowledgeBase(state.knowledge[state.agents[id].knowledgeRevisionId]));
      const form = createFormUpdate(base, edit, { lineage, idempotencyKey: 'k', now: NOW, newId });
      const decisions = form.update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' }));
      const applying = applyUpdate(form.base, form.update.updateId, { expectedVersion: 1, decisions }, { now: NOW, newId });
      const sourceIds = mode === 'library' ? [...new Set([...lineage.sourceIds, ...sourcesAddedBy(base, applying.base)])] : undefined;
      const published = publishRevision(state, { stableAgentId: id, baseAgentVersionId: lineage.currentAgentVersionId, expectedGeneration: lineage.pointerGeneration, knowledgeBase: applying.base, sourceIds, kind: 'knowledge', now: NOW, newId });
      state = published.state;
      snapshots.push(JSON.stringify({ knowledge: knowledgeOf(state, id), agent: state.agents[published.agentVersionId] }));
    }
    return { state, snapshots };
  }
  const EDITS = [
    { action: 'add', group: 'services', value: 'Teeth whitening' },
    { action: 'remove', group: 'services', targetEntryId: RESEARCH_IDS.service2 },
    { action: 'add', group: 'faq', value: 'We open late on Thursdays' },
    { action: 'replace', group: 'office_hours', targetEntryId: RESEARCH_IDS.hours, value: 'Monday to Saturday 8am to 6pm' },
  ];

  it('compiles the same snapshot after every edit in a chain of four publishes', () => {
    const legacy = run('legacy', EDITS);
    const library = run('library', EDITS);
    expect(library.snapshots).toHaveLength(4);
    expect(library.snapshots).toEqual(legacy.snapshots);
  });

  it('a lineage without sourceIds compiles all of its own knowledge and stays on the per-agent base', () => {
    const { state } = run('legacy', EDITS.slice(0, 1));
    expect(readLineage(state, ctx.owner.agentId).sourceIds).toBeUndefined();
    expect(state.knowledgeLibrary).toBeUndefined();
    expect(state.knowledgeBases[ctx.owner.agentId].sources).toBeDefined();
    expect(knowledgeOf(state, ctx.owner.agentId).ownerFacts.map((fact) => fact.value)).toEqual(['Teeth whitening']);
  });

  it('reading a legacy scope shows the same library without changing the state', () => {
    const state = structuredClone(ctx.owner.state);
    const before = JSON.stringify(state);
    expect(Object.keys(readKnowledgeBase(state, ctx.owner.agentId).entries)).toContain(RESEARCH_IDS.service);
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ------------------------------------------------------------------ HTTP

const call = async (client, method, path, body, key) => {
  const response = await client.request(method, path, { ...(body ? { body } : {}), ...(key ? { headers: { 'idempotency-key': key } } : {}) });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
};
const agentPath = (id, suffix = '') => `/v1/agents/${id}${suffix}`;
const knowledgeOfAgent = async (owner, client) => (await call(client, 'GET', agentPath(owner.agentId, '/knowledge'))).body;
const select = (owner, client, body, key) => call(client, 'PUT', agentPath(owner.agentId, '/knowledge-sources-selection'), body, key);
const allEntries = (view) => view.categories.flatMap((category) => category.entries);
/** Adds one owner fact through the real review and apply flow and returns the new source id (each form edit makes its own source). */
async function addFact(owner, client, value, group = 'services') {
  const view = await knowledgeOfAgent(owner, client);
  const created = await call(client, 'POST', agentPath(owner.agentId, '/knowledge-updates'), { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, op: 'add', group, value }, randomUUID());
  expect(created.status).toBe(202);
  const decisions = created.body.update.candidates.map((candidate) => ({ candidateId: candidate.candidateId, decision: 'accept' }));
  const applied = await call(client, 'POST', agentPath(owner.agentId, `/knowledge-updates/${created.body.update.updateId}/apply`), { expectedVersion: created.body.update.version, decisions }, randomUUID());
  expect(applied.status).toBe(202);
  return created.body.update.candidates[0].sourceId;
}
const newOwner = async () => { const owner = await seedClaimedOwner(ctx.pg, { researched: true }); return { owner, client: browserClient(ctx.app, owner.authToken) }; };
const snapshotOf = async (owner, versionId) => { const state = await scopeState(ctx.pg, owner.scopeId); return state.knowledge[state.agents[versionId].knowledgeRevisionId]; };

describe('reading the library', () => {
  it('lists each source with the receptionists that use it and the current selection, without writing', async () => {
    const { owner, client } = await newOwner();
    const view = await knowledgeOfAgent(owner, client);
    expect(view.sourceIds).toEqual(['src-p1']);
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]).toMatchObject({ sourceId: 'src-p1', type: 'website', origin: 'onboarding_website', usedBy: [{ stableAgentId: owner.agentId, name: 'Blake' }] });
    expect(allEntries(view).map((entry) => entry.value)).toEqual(expect.arrayContaining(['Teeth cleaning', 'Fillings']));
    const state = await scopeState(ctx.pg, owner.scopeId);
    expect(state.knowledgeLibrary).toBeUndefined();
    expect(state.knowledgeBases).toBeUndefined();
  });

  it('runs the backfill on the first write and stores the library and the selection', async () => {
    const { owner, client } = await newOwner();
    const noteSource = await addFact(owner, client, 'Teeth whitening');
    const state = await scopeState(ctx.pg, owner.scopeId);
    expect(state.knowledgeBases).toBeUndefined();
    expect(Object.keys(state.knowledgeLibrary.sources).sort()).toEqual(['src-p1', noteSource].sort());
    expect(state.agentLineages[owner.agentId].sourceIds.sort()).toEqual(['src-p1', noteSource].sort());
    expect(state.knowledgeLibrary.sources['src-p1'].origin).toBe('onboarding_website');
    expect((await knowledgeOfAgent(owner, client)).sources.find((source) => source.sourceId === noteSource).usedBy).toEqual([{ stableAgentId: owner.agentId, name: 'Blake' }]);
  });
});

describe('MR-T3: choosing sources publishes a smaller version and keeps the older ones', () => {
  it('narrows the snapshot, keeps version 2 as it was, and brings the facts back when the source is selected again', async () => {
    const { owner, client } = await newOwner();
    const note = await addFact(owner, client, 'Teeth whitening');
    const v2 = (await knowledgeOfAgent(owner, client)).currentAgentVersionId;
    const full = await snapshotOf(owner, v2);
    expect(full.groupedFacts).toHaveLength(5);
    expect(full.ownerFacts.map((fact) => fact.value)).toEqual(['Teeth whitening']);

    const onlyNote = await select(owner, client, { sourceIds: [note], expectedAgentVersionId: v2 });
    expect(onlyNote.status).toBe(200);
    expect(onlyNote.body).toMatchObject({ stableAgentId: owner.agentId, pointerGeneration: 3, versionNumber: 3, sourceIds: [note] });
    expect(onlyNote.body.currentAgentVersionId).not.toBe(v2);
    const narrow = await snapshotOf(owner, onlyNote.body.currentAgentVersionId);
    expect(narrow.groupedFacts).toEqual([]);
    expect(narrow.facts).toEqual([]);
    expect(narrow.classifiedPassages).toEqual([]);
    expect(narrow.ownerFacts.map((fact) => fact.value)).toEqual(['Teeth whitening']);
    expect(JSON.stringify(narrow)).not.toContain('riverside.example');
    // Older versions keep what they had.
    expect(await snapshotOf(owner, v2)).toEqual(full);
    expect(await snapshotOf(owner, owner.agentId)).toMatchObject({ groupedFacts: expect.any(Array) });
    const view = await knowledgeOfAgent(owner, client);
    expect(view.sourceIds).toEqual([note]);
    expect(view.sources.find((source) => source.sourceId === 'src-p1').usedBy).toEqual([]);

    const both = await select(owner, client, { sourceIds: ['src-p1', note], expectedAgentVersionId: onlyNote.body.currentAgentVersionId });
    expect(both.status).toBe(200);
    const restored = await snapshotOf(owner, both.body.currentAgentVersionId);
    expect(restored.groupedFacts).toEqual(full.groupedFacts);
    expect(restored.facts).toEqual(full.facts);
    expect(restored.ownerFacts).toEqual(full.ownerFacts);
  });

  it('selecting only the website drops the owner note from the new version', async () => {
    const { owner, client } = await newOwner();
    await addFact(owner, client, 'Teeth whitening');
    const view = await knowledgeOfAgent(owner, client);
    const saved = await select(owner, client, { sourceIds: ['src-p1'], expectedAgentVersionId: view.currentAgentVersionId });
    expect(saved.status).toBe(200);
    expect((await snapshotOf(owner, saved.body.currentAgentVersionId)).ownerFacts).toEqual([]);
    expect((await snapshotOf(owner, view.currentAgentVersionId)).ownerFacts).toHaveLength(1);
  });

  it('allows an empty selection and publishes an empty snapshot', async () => {
    const { owner, client } = await newOwner();
    const saved = await select(owner, client, { sourceIds: [], expectedAgentVersionId: owner.agentId });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ sourceIds: [], pointerGeneration: 2, versionNumber: 2 });
    const snapshot = await snapshotOf(owner, saved.body.currentAgentVersionId);
    expect([snapshot.groupedFacts, snapshot.ownerFacts, snapshot.facts]).toEqual([[], [], []]);
    const view = await knowledgeOfAgent(owner, client);
    expect(view.sourceIds).toEqual([]);
    expect(view.pointerGeneration).toBe(2);
    // The receptionist can take knowledge again.
    const again = await select(owner, client, { sourceIds: ['src-p1'], expectedAgentVersionId: saved.body.currentAgentVersionId });
    expect((await snapshotOf(owner, again.body.currentAgentVersionId)).groupedFacts).toHaveLength(5);
  });

  it('republishes with the same selection when capabilities are saved', async () => {
    const { owner, client } = await newOwner();
    const note = await addFact(owner, client, 'Teeth whitening');
    const view = await knowledgeOfAgent(owner, client);
    const narrowed = await select(owner, client, { sourceIds: [note], expectedAgentVersionId: view.currentAgentVersionId });
    const saved = await call(client, 'PATCH', agentPath(owner.agentId, '/capabilities'), { baseAgentVersionId: narrowed.body.currentAgentVersionId, expectedPointerGeneration: narrowed.body.pointerGeneration, workflows: { 'WF-05': false } }, randomUUID());
    expect(saved.status).toBe(200);
    const snapshot = await snapshotOf(owner, saved.body.currentAgentVersionId);
    expect(snapshot.groupedFacts).toEqual([]);
    expect(snapshot.ownerFacts.map((fact) => fact.value)).toEqual(['Teeth whitening']);
    expect((await knowledgeOfAgent(owner, client)).sourceIds).toEqual([note]);
  });

  it('a new fact added through an update joins the selection even when the website is deselected', async () => {
    const { owner, client } = await newOwner();
    const note = await addFact(owner, client, 'Teeth whitening');
    const view = await knowledgeOfAgent(owner, client);
    await select(owner, client, { sourceIds: [note], expectedAgentVersionId: view.currentAgentVersionId });
    const second = await addFact(owner, client, 'Root canals');
    const after = await knowledgeOfAgent(owner, client);
    expect(after.sourceIds.sort()).toEqual([note, second].sort());
    expect((await snapshotOf(owner, after.currentAgentVersionId)).ownerFacts.map((fact) => fact.value).sort()).toEqual(['Root canals', 'Teeth whitening']);
  });
});

describe('selection validation and isolation', () => {
  it('rejects bad input, unknown sources and a stale version, and publishes nothing', async () => {
    const { owner, client } = await newOwner();
    const before = (await knowledgeOfAgent(owner, client)).pointerGeneration;
    const bad = [
      [{ expectedAgentVersionId: owner.agentId }, 400], [{ sourceIds: 'src-p1', expectedAgentVersionId: owner.agentId }, 400], [{ sourceIds: [1], expectedAgentVersionId: owner.agentId }, 400],
      [{ sourceIds: ['src-p1'] }, 400], [{ sourceIds: ['missing'], expectedAgentVersionId: owner.agentId }, 422], [{ sourceIds: ['src-p1', 'missing'], expectedAgentVersionId: owner.agentId }, 422],
    ];
    for (const [body, status] of bad) expect((await select(owner, client, body)).status, JSON.stringify(body)).toBe(status);
    const stale = await select(owner, client, { sourceIds: ['src-p1'], expectedAgentVersionId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ title: 'stale_agent_version', currentAgentVersionId: owner.agentId, currentPointerGeneration: 1 });
    expect((await call(client, 'PUT', agentPath(owner.agentId, '/knowledge-sources-selection'), [])).status).toBe(400);
    expect((await knowledgeOfAgent(owner, client)).pointerGeneration).toBe(before);
  });

  it('refuses a selection that leaves no service in the chosen sources', async () => {
    const { owner, client } = await newOwner();
    const note = await addFact(owner, client, 'We open late on Thursdays', 'faq');
    const view = await knowledgeOfAgent(owner, client);
    const saved = await select(owner, client, { sourceIds: [note], expectedAgentVersionId: view.currentAgentVersionId });
    expect(saved.status).toBe(422);
    expect((await knowledgeOfAgent(owner, client)).currentAgentVersionId).toBe(view.currentAgentVersionId);
  });

  it('counts a duplicate id once', async () => {
    const { owner, client } = await newOwner();
    const saved = await select(owner, client, { sourceIds: ['src-p1', 'src-p1'], expectedAgentVersionId: owner.agentId });
    expect(saved.body.sourceIds).toEqual(['src-p1']);
  });

  it('replays a retry with the same Idempotency-Key and rejects the key with different content', async () => {
    const { owner, client } = await newOwner();
    const key = randomUUID();
    const first = await select(owner, client, { sourceIds: ['src-p1'], expectedAgentVersionId: owner.agentId }, key);
    const retry = await select(owner, client, { sourceIds: ['src-p1'], expectedAgentVersionId: owner.agentId }, key);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replay')).toBe('true');
    expect(retry.body).toMatchObject({ currentAgentVersionId: first.body.currentAgentVersionId, pointerGeneration: 2 });
    expect((await select(owner, client, { sourceIds: [], expectedAgentVersionId: first.body.currentAgentVersionId }, key)).status).toBe(409);
    expect((await knowledgeOfAgent(owner, client)).pointerGeneration).toBe(2);
  });

  it('is closed to another owner and to sources from another owner scope', async () => {
    const one = await newOwner();
    const two = await newOwner();
    const foreign = await addFact(two.owner, two.client, 'Foreign service');
    expect((await select(one.owner, two.client, { sourceIds: ['src-p1'], expectedAgentVersionId: one.owner.agentId })).status).toBe(404);
    expect((await select(one.owner, browserClient(ctx.app, null), { sourceIds: ['src-p1'], expectedAgentVersionId: one.owner.agentId })).status).toBe(404);
    expect((await select(one.owner, one.client, { sourceIds: ['src-p1', foreign], expectedAgentVersionId: one.owner.agentId })).status).toBe(422);
    expect((await knowledgeOfAgent(one.owner, one.client)).pointerGeneration).toBe(1);
    expect(JSON.stringify(await knowledgeOfAgent(one.owner, one.client))).not.toContain('Foreign service');
    expect((await scopeState(ctx.pg, one.owner.scopeId)).knowledgeLibrary).toBeUndefined();
  });
});

describe('two receptionists in one scope', () => {
  const SENTINEL = 'LIBRARY-ERASE-SENTINEL';

  /** No create path exists yet, so the second receptionist is written into the scope directly, sharing version 2's knowledge. */
  async function twoReceptionists() {
    const { owner, client } = await newOwner();
    const OTHER = randomUUID();
    const note = await addFact(owner, client, SENTINEL);
    const view = await knowledgeOfAgent(owner, client);
    await asOwner(ctx.pg, async () => {
      const state = (await ctx.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
      const current = state.agents[view.currentAgentVersionId];
      state.agents[OTHER] = { ...current, id: OTHER, businessName: 'Riverside Dental' };
      state.agentLineages[OTHER] = {
        stableAgentId: OTHER, name: 'Front desk', pointerGeneration: 1, currentAgentVersionId: OTHER,
        revisions: [{ agentVersionId: OTHER, knowledgeRevisionId: current.knowledgeRevisionId, parentAgentVersionId: null, kind: 'initial', createdAt: NOW.toISOString(), createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }],
        sourceIds: ['src-p1', note],
      };
      await ctx.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
      await ctx.pg.query("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('agent',$1,$2,$3)", [OTHER, owner.scopeId, owner.tenant]);
    });
    return { owner, client, note, view, OTHER };
  }

  it('shows every receptionist that uses a source, with its name', async () => {
    const { owner, client, note, OTHER } = await twoReceptionists();
    const view = await knowledgeOfAgent(owner, client);
    const usedBy = view.sources.find((source) => source.sourceId === note).usedBy;
    expect(usedBy).toEqual([{ stableAgentId: owner.agentId, name: 'Blake' }, { stableAgentId: OTHER, name: 'Front desk' }]);
    const fromOther = (await call(client, 'GET', agentPath(OTHER, '/knowledge'))).body;
    expect(fromOther).toMatchObject({ stableAgentId: OTHER, currentAgentVersionId: OTHER, sourceIds: ['src-p1', note] });
    expect(fromOther.sources.map((source) => source.sourceId).sort()).toEqual(['src-p1', note].sort());
  });

  it('a selection change for one receptionist leaves the other alone', async () => {
    const { owner, client, note, OTHER } = await twoReceptionists();
    const view = await knowledgeOfAgent(owner, client);
    const saved = await call(client, 'PUT', agentPath(OTHER, '/knowledge-sources-selection'), { sourceIds: ['src-p1'], expectedAgentVersionId: OTHER });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ stableAgentId: OTHER, pointerGeneration: 2, sourceIds: ['src-p1'] });
    const after = await knowledgeOfAgent(owner, client);
    expect(after.currentAgentVersionId).toBe(view.currentAgentVersionId);
    expect(after.sourceIds.sort()).toEqual(['src-p1', note].sort());
    expect((await snapshotOf(owner, view.currentAgentVersionId)).ownerFacts).toHaveLength(1);
    expect((await snapshotOf(owner, saved.body.currentAgentVersionId)).ownerFacts).toEqual([]);
  });

  it('keeps one receptionist\'s open changes out of the other\'s view', async () => {
    const { owner, client, view, OTHER } = await twoReceptionists();
    const created = await call(client, 'POST', agentPath(owner.agentId, '/knowledge-updates'), { inputType: 'form', baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, op: 'add', group: 'faq', value: 'Parking is free' }, randomUUID());
    expect(created.status).toBe(202);
    const updateId = created.body.update.updateId;
    expect((await knowledgeOfAgent(owner, client)).openUpdates.map((update) => update.updateId)).toEqual([updateId]);
    expect((await call(client, 'GET', agentPath(OTHER, '/knowledge'))).body.openUpdates).toEqual([]);
    expect((await call(client, 'GET', agentPath(OTHER, `/knowledge-updates/${updateId}`))).status).toBe(404);
    expect((await call(client, 'POST', agentPath(OTHER, `/knowledge-updates/${updateId}/cancel`), { expectedVersion: 1 })).status).toBe(404);
  });

  it('erasing a shared source removes it from every receptionist and recompiles each one', async () => {
    const { owner, client, note, view, OTHER } = await twoReceptionists();
    const started = await call(client, 'POST', agentPath(owner.agentId, `/knowledge-sources/${note}/erase`), { confirm: true, expectedPointerGeneration: view.pointerGeneration });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'pending', versionsAffected: 2 });
    await ctx.api.postOnboardingIdle();
    const job = (await call(client, 'GET', agentPath(owner.agentId, `/knowledge-sources/${note}/erase/${started.body.jobId}`))).body;
    expect(job).toMatchObject({ status: 'completed', remainingKnowledge: 'recompiled', versionsAffected: 2 });

    const state = await scopeState(ctx.pg, owner.scopeId);
    expect(JSON.stringify(state)).not.toContain(SENTINEL);
    for (const id of [owner.agentId, OTHER]) {
      const lineage = state.agentLineages[id];
      expect(lineage.sourceIds).toEqual(['src-p1']);
      expect(lineage.pointerGeneration).toBe(id === owner.agentId ? 3 : 2);
      const affected = lineage.revisions.filter((revision) => revision.fencedAt && revision.erasedAt);
      expect(affected.map((revision) => revision.agentVersionId)).toEqual([id === owner.agentId ? view.currentAgentVersionId : OTHER]);
      const current = state.agents[lineage.currentAgentVersionId];
      expect(state.knowledge[current.knowledgeRevisionId].groupedFacts).toHaveLength(5);
      expect(state.knowledge[current.knowledgeRevisionId].ownerFacts).toEqual([]);
    }
    expect(state.knowledgeLibrary.sources[note]).toMatchObject({ label: '', erasedAt: expect.any(String) });
    const after = await knowledgeOfAgent(owner, client);
    expect(after.sources.map((source) => source.sourceId)).toEqual(['src-p1']);
    expect(after.sources[0].usedBy.map((item) => item.stableAgentId).sort()).toEqual([OTHER, owner.agentId].sort());
  });

  it('a receptionist whose selection did not include the erased source keeps its version', async () => {
    const { owner, client, note, view, OTHER } = await twoReceptionists();
    const narrowed = await call(client, 'PUT', agentPath(OTHER, '/knowledge-sources-selection'), { sourceIds: ['src-p1'], expectedAgentVersionId: OTHER });
    const started = await call(client, 'POST', agentPath(owner.agentId, `/knowledge-sources/${note}/erase`), { confirm: true, expectedPointerGeneration: view.pointerGeneration });
    await ctx.api.postOnboardingIdle();
    expect(started.body.versionsAffected).toBe(2);
    const state = await scopeState(ctx.pg, owner.scopeId);
    // The other receptionist's original version held the source, so it is fenced; its current version does not and stays current.
    expect(state.agentLineages[OTHER].currentAgentVersionId).toBe(narrowed.body.currentAgentVersionId);
    expect(state.agentLineages[OTHER].revisions.find((revision) => revision.agentVersionId === OTHER)).toMatchObject({ fencedAt: expect.any(String), erasedAt: expect.any(String) });
    expect(state.agentLineages[OTHER].sourceIds).toEqual(['src-p1']);
  });
});
