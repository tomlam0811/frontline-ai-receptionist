import { passagesFromResearch } from './passages.js';
import { classifyPassages } from './jev-classifier.js';
import { admitExtractedFacts } from './evidence.js';
import { compileGroupedProfile } from './grouped-profile.js';
import { findPublishedContacts } from './published-contacts.js';

export async function buildSourceGroundedProfile(research, options = {}) {
  const passages = passagesFromResearch(research);
  if (!passages.length) return { identityFactIds: [], state: 'missing', passages: [], classifiedPassages: [], eligibleFacts: [], groupedProfile: null };
  const classifiedPassages = (await classifyPassages(passages, options.classify)).map((passage) => ({
    passageId: passage.passageId, source: passage.source, text: passage.text,
    classifications: passage.classifications, classificationModel: 'jev-1.13.0',
  }));
  const modelExtracted = await options.extract(classifiedPassages);
  const rawExtracted = [...modelExtracted, ...findPublishedContacts(classifiedPassages, modelExtracted)];
  const extracted = [...new Map(rawExtracted.map((fact) => [JSON.stringify([fact.group, fact.value, String(fact.scope ?? '').toLowerCase().replace(/\s+/g, ' ').trim(), [...new Set(fact.passageIds ?? [])].sort()]), fact])).values()];
  const eligibleFacts = admitExtractedFacts(extracted, classifiedPassages, options.observedAt);
  const groupedProfile = compileGroupedProfile(eligibleFacts, classifiedPassages, options.observedAt);
  const identityFactIds = eligibleFacts.filter((fact, index) => fact.group === 'identity_contact' && extracted[index]?.kind === 'business_name' && fact.eligibility === 'eligible').map((fact) => fact.factId);
  return { identityFactIds, state: eligibleFacts.some((fact) => fact.eligibility === 'eligible') ? 'ready' : 'missing', passages, classifiedPassages, eligibleFacts, groupedProfile };
}
