import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateContract } from '../../contracts/v1/contract-validator.js';

// PO-C3: owner-supplied knowledge can be described by the source-knowledge contract, and nothing that
// validated before stops validating. The shared positive and negative cases live in contracts/v1/fixtures.json
// and run in both JavaScript (tests/contracts-v1.test.js) and Python (npm run check:contracts).
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PASSAGE = 'source-knowledge.schema.json#/$defs/classifiedPassage';
const FACT = 'source-knowledge.schema.json#/$defs/eligibleFact';
const website = { passageId: id(1), source: { sourceId: id(2), url: 'https://riverside.example/about', retrievedAt: '2026-09-26T12:00:00.000Z' }, text: 'Open Monday to Friday.', classifications: ['office_hours'], classificationModel: 'jev-1.13.0' };
const ownerSource = { sourceId: id(3), sourceType: 'owner_document', label: 'Price list', filename: 'prices.pdf', retrievedAt: '2026-09-26T12:00:00.000Z' };

describe('owner source contract', () => {
  it('keeps a website passage valid and accepts an owner passage', () => {
    expect(validateContract(PASSAGE, website)).toBe(website);
    const owner = { ...website, source: ownerSource, classifications: ['other'], classificationModel: 'owner-attested-v1' };
    expect(validateContract(PASSAGE, owner)).toBe(owner);
    const ownerUrl = { ...owner, source: { ...ownerSource, sourceType: 'owner_url', url: 'https://owner.example/menu' } };
    expect(validateContract(PASSAGE, ownerUrl)).toBe(ownerUrl);
  });

  it('rejects mixed or malformed sources and unknown values', () => {
    const bad = (patch) => () => validateContract(PASSAGE, { ...website, ...patch });
    expect(bad({ source: { ...website.source, sourceType: 'owner_text' } })).toThrow();
    expect(bad({ source: { ...ownerSource, url: 'http://owner.example/menu' } })).toThrow();
    expect(bad({ source: { ...ownerSource, extra: true } })).toThrow();
    expect(bad({ source: { ...ownerSource, sourceType: 'website' } })).toThrow();
    expect(bad({ classificationModel: 'made-up-1' })).toThrow();
    expect(bad({ classifications: ['made_up'] })).toThrow();
  });

  it('accepts the group other on an eligible fact and still rejects unknown groups', () => {
    const fact = { factId: id(4), group: 'other', value: 'We do not serve Tacoma.', passageIds: [id(1)], applicableServiceIds: [], applicableLocationIds: [], eligibility: 'eligible', eligibilityReason: 'owner review', observedAt: '2026-09-26T12:00:00.000Z', confidenceEvidence: { score: 1, basis: 'direct_passage', explanation: 'Stated by the owner.' } };
    expect(validateContract(FACT, fact)).toBe(fact);
    expect(() => validateContract(FACT, { ...fact, group: 'made_up' })).toThrow();
  });

  it('is carried by the generated TypeScript and Python mirrors', async () => {
    const typescript = await readFile('contracts/v1/typescript/index.ts', 'utf8');
    const python = await readFile('contracts/v1/python/wire_types.py', 'utf8');
    for (const text of [typescript, python]) {
      expect(text).toContain('OwnerSourceRef');
      expect(text).toContain('owner-attested-v1');
      expect(text).toMatch(/'faq', 'other'|"faq" \| "other"/);
    }
  });
});
