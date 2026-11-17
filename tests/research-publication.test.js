import { describe, expect, it } from 'vitest';
import { prepareBusinessFromWebsite } from '../server/business-preparation.js';
import { createPreparationQueue } from '../server/api/preparation-queue.js';
import { compileBusinessKnowledge, lookupBusinessFacts } from '../server/api/knowledge.js';
import { buildSourceGroundedProfile } from '../server/research/pipeline.js';

const source = (text, suffix = '') => ({ finalUrl: `https://business.example/${suffix}`, title: 'Home', excerpt: text, retrievedAt: '2026-09-24T00:00:00.000Z' });
const classify = async (passage) => ({ ...passage, classifications: ['identity_contact', 'services', 'office_hours'] });
const extract = async ([p]) => [
  { group: 'identity_contact', kind: 'business_name', value: 'Example Co', passageIds: [p.passageId] },
  ...['apartment cleaning', 'pressure washing'].map((value) => ({ group: 'services', kind: 'statement', value, passageIds: [p.passageId] })),
];
const prepare = (text) => prepareBusinessFromWebsite('https://business.example/', { researchPipeline: true, crawl: async () => ({ pages: [source(text)] }), classify, extract });

describe('reviewed research publication path', () => {
  it('publishes body identity and all supported services through the real queue under the same revision', async () => {
    const prepared = await prepare('Example Co offers apartment cleaning and pressure washing.');
    const state = { preparations: { p: { state: 'researching', workspaceId: 'w', expiresAt: new Date(Date.now() + 60_000).toISOString() } }, knowledge: {}, agents: {} };
    let published;
    const persisted = new Promise((resolve) => { published = resolve; });
    const store = { transaction: async (fn) => { fn(state); published(); } };
    const queue = createPreparationQueue({ store, prepare: async () => prepared });
    expect(await queue.enqueue({ id: 'p', workspaceId: 'w', clientKey: 'fixture', url: 'https://business.example/' })).toBe('admitted');
    await persisted;
    const record = state.preparations.p;
    expect(record.state).toBe('limited_ready');
    expect(record.knowledgeRevisionId).toBe(prepared.groupedProfile.knowledgeRevisionId);
    const knowledge = state.knowledge[record.knowledgeRevisionId];
    expect(knowledge.groupedProfile).toEqual(prepared.groupedProfile);
    expect(knowledge.classifiedPassages).toEqual(prepared.sourceKnowledge.classifiedPassages);
    expect(knowledge.groupedFacts).toHaveLength(3);
    expect(lookupBusinessFacts(knowledge.facts, 'Do you offer pressure washing?')).toEqual([expect.objectContaining({ value: 'pressure washing' })]);
  });

  it('cannot publish stale legacy values or contact information as company identity', async () => {
    const stale = await prepare('Archived. Example Co offers apartment cleaning and pressure washing.');
    expect(stale.profile.services).toEqual([]);
    expect(compileBusinessKnowledge(stale)).toBeNull();
    const contact = await prepareBusinessFromWebsite('https://business.example/', { researchPipeline: true, crawl: async () => ({ pages: [source('Call 555-0100 for pressure washing.')] }), classify, extract: async ([p]) => [
      { group: 'identity_contact', kind: 'contact', value: '555-0100', passageIds: [p.passageId] },
      { group: 'services', value: 'pressure washing', passageIds: [p.passageId] },
    ] });
    expect(contact.profile.businessName).toBeNull();
    expect(compileBusinessKnowledge(contact)).toBeNull();
  });

  it('retains conflict evidence on publication while excluding it from runtime answers', async () => {
    const prepared = await prepareBusinessFromWebsite('https://business.example/', {
      researchPipeline: true,
      crawl: async () => ({ pages: [source('Example Co offers pressure washing. Office hours Monday 9am to 5pm.', 'a'), source('Office hours Monday 10am to 6pm.', 'b')] }),
      classify,
      extract: async ([a, b]) => [
        { group: 'identity_contact', kind: 'business_name', value: 'Example Co', passageIds: [a.passageId] },
        { group: 'services', value: 'pressure washing', passageIds: [a.passageId] },
        { group: 'office_hours', value: 'Monday 9am to 5pm', passageIds: [a.passageId] },
        { group: 'office_hours', value: 'Monday 10am to 6pm', passageIds: [b.passageId] },
      ],
    });
    const state = { preparations: { p: { state: 'researching', workspaceId: 'w', expiresAt: new Date(Date.now() + 60_000).toISOString() } }, knowledge: {}, agents: {} };
    let published;
    const persisted = new Promise((resolve) => { published = resolve; });
    const queue = createPreparationQueue({ store: { transaction: async (fn) => { fn(state); published(); } }, prepare: async () => prepared });
    await queue.enqueue({ id: 'p', workspaceId: 'w', clientKey: 'fixture', url: 'https://business.example/' });
    await persisted;
    const knowledge = state.knowledge[state.preparations.p.knowledgeRevisionId];
    expect(knowledge.groupedFacts.filter((fact) => fact.eligibility === 'conflicting')).toHaveLength(2);
    expect(knowledge.groupedFacts).toEqual(prepared.groupedFacts);
    expect(lookupBusinessFacts(knowledge.facts, 'What are your hours?')).toEqual([]);
  });

  it('rejects category drift and negated service claims', async () => {
    const result = await buildSourceGroundedProfile({ pages: [source('Office hours are Monday 9am to 5pm. We do not offer carpet cleaning.')] }, { classify, extract: async ([p]) => [
      { group: 'appointment_hours', value: 'Monday 9am to 5pm', passageIds: [p.passageId] },
      { group: 'services', value: 'carpet cleaning', passageIds: [p.passageId] },
    ] });
    expect(result.eligibleFacts.map((f) => f.eligibility)).toEqual(['unknown', 'unknown']);
  });

  it('deduplicates exact extraction repeats while keeping distinct location scopes addressable', async () => {
    const result = await buildSourceGroundedProfile({ pages: [source('Pressure washing in Irvine and Anaheim.')] }, {
      classify,
      extract: async ([p]) => ['Irvine', 'irvine', ' Irvine ', 'Anaheim'].map((scope) => ({ group: 'services', value: 'Pressure washing', scope, passageIds: [p.passageId] })),
    });
    expect(result.eligibleFacts).toHaveLength(2);
    expect(new Set(result.eligibleFacts.map(fact => fact.factId)).size).toBe(2);
    expect(result.groupedProfile.groups.services).toHaveLength(2);
  });

  it('separates nonoverlapping weekdays and explicit locations, but rejects overlapping conflicts', async () => {
    const pages = [source('Office hours in Irvine: Monday 9am to 5pm.', 'a'), source('Office hours in Irvine: Tuesday 10am to 6pm.', 'b'), source('Office hours in Anaheim: Monday 8am to 4pm.', 'c')];
    const run = (input) => buildSourceGroundedProfile({ pages: input }, { classify, extract: async (passages) => passages.map((p) => ({ group: 'office_hours', value: p.text, scope: p.text.includes('Irvine') ? 'Irvine' : 'Anaheim', passageIds: [p.passageId] })) });
    const result = await run(pages);
    expect(result.eligibleFacts.map((f) => f.eligibility)).toEqual(['eligible','eligible','eligible']);
    expect(result.eligibleFacts[0].applicableLocationIds).not.toEqual(result.eligibleFacts[2].applicableLocationIds);
    const conflict = await run([pages[0], source('Office hours in Irvine: Monday 10am to 6pm.', 'd')]);
    expect(conflict.eligibleFacts.map((f) => f.eligibility)).toEqual(['conflicting','conflicting']);
  });
});
