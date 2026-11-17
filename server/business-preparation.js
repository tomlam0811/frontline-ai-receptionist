import { validateInspectionUrl } from './website-inspection.js';
import { researchWebsiteWithExa } from './exa-website-research.js';
import { createJevClassifier } from './research/jev-classifier.js';
import { createStructuredExtractor } from './research/openai-extractor.js';
import { assessBusinessFit, createBusinessFitAssessor } from './research/business-fit.js';
import { buildSourceGroundedProfile } from './research/pipeline.js';

// This is deliberately a small, deterministic extractor. Page text is evidence,
// never an instruction to the application or to Bob. Unsupported services stay
// unknown until a reviewed extraction path can support them.
/** @type {Array<[string, RegExp]>} */
const SERVICE_TERMS = [
  ['Apartment cleaning', /\bapartment clean(?:ing|ings)\b/i],
  ['House cleaning', /\b(?:house|home) clean(?:ing|ings)\b/i],
  ['Deep cleaning', /\bdeep clean(?:ing|ings)\b/i],
  ['Carpet cleaning', /\bcarpet clean(?:ing|ings)\b/i],
  ['Lawn care', /\blawn care\b/i],
  ['Plumbing repair', /\bplumb(?:ing|er) repairs?\b/i],
  ['Drain cleaning', /\bdrain clean(?:ing|ings)\b/i],
  ['Electrical repair', /\belectrical repairs?\b/i],
  ['HVAC maintenance', /\b(?:hvac|heating and cooling) maintenance\b/i],
  ['Air conditioning repair', /\b(?:air conditioning|a\/?c) repairs?\b/i],
  ['Furnace repair', /\bfurnace repairs?\b/i],
  ['Appliance repair', /\bappliance repairs?\b/i],
  ['Pest control', /\bpest control\b/i],
  ['Haircuts', /\bhaircuts?\b/i],
  ['Hair coloring', /\bhair colo(?:r|ur)(?:ing)?\b/i],
  ['Manicures', /\bmanicures?\b/i],
  ['Massage therapy', /\bmassage therapy\b/i],
  ['Oil changes', /\boil changes?\b/i],
  ['Brake repair', /\bbrake repairs?\b/i],
  ['Vehicle inspections', /\b(?:vehicle|car|auto) inspections?\b/i],
  ['Dental cleaning', /\bdental clean(?:ing|ings)\b/i],
  ['Pet grooming', /\b(?:pet|dog|cat) groom(?:ing|ings)\b/i],
  ['Physical therapy', /\bphysical therapy\b/i],
  ['Auto detailing', /\b(?:auto|car|vehicle) detail(?:ing|ings)\b/i],
];

const WEEKDAY = '(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)';
const CLOCK = '(?:0?[1-9]|1[0-2])(?::[0-5]\\d)?\\s*(?:am|pm)';
const HOURS_PATTERN = new RegExp(`\\b${WEEKDAY}(?:\\s*(?:-|–|to)\\s*${WEEKDAY})?\\s*[:,-]?\\s*${CLOCK}\\s*(?:-|–|to)\\s*${CLOCK}\\b`, 'i');
const PAGE_INSTRUCTION = /\b(?:ignore (?:all |your |previous )?instructions|disregard (?:all |your |previous )?instructions|system prompt|developer message|you must (?:say|respond|claim|pretend)|assistant[:,]|fabricate|pretend (?:to|that))\b/i;
const NEGATED_SERVICE = /\b(?:no|not|never|don't|do not|does not|without)\b/i;
const NEGATED_AFTER_SERVICE = /^\s*(?:[,:;.!?]\s*)?(?:(?:is|are)\s+)?(?:not|never|no longer|unavailable)\b/i;
const GENERIC_TITLE = /^(?:home|homepage|welcome|services?|about(?: us)?|contact(?: us)?|book(?: now)?|appointments?)$/i;

function sentences(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s*[\n\r]+\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !PAGE_INSTRUCTION.test(part));
}

function identityCandidate(value) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length >= 3 && clean.length <= 80 && !GENERIC_TITLE.test(clean)
    && !PAGE_INSTRUCTION.test(clean) && !/^(?:best|top|local|find|book|near me)\b/i.test(clean)
    ? clean : null;
}

function titleCandidates(title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 200 || PAGE_INSTRUCTION.test(clean)) return [];
  return clean.split(/\s+[|–—-]\s+/).map(identityCandidate).filter(Boolean);
}

function identityFromPage(title, siteName) {
  const explicit = identityCandidate(siteName);
  if (explicit) return { value: explicit, field: 'siteName', quote: siteName };
  const candidates = titleCandidates(title);
  return candidates.length === 1 ? { value: candidates[0], field: 'title', quote: title } : null;
}

function sameSubmittedSite(requestedUrl, finalUrl) {
  const requested = validateInspectionUrl(requestedUrl).hostname.replace(/^www\./, '');
  const final = validateInspectionUrl(finalUrl).hostname.replace(/^www\./, '');
  return requested === final;
}

function sourceEvidence(sourceUrl, field, quote) {
  return { sourceUrl, field, quote };
}

export function profileFromInspection(inspection) {
  const { requestedUrl, finalUrl, title, siteName, description, excerpt } = inspection ?? {};
  if (!requestedUrl || !finalUrl || !sameSubmittedSite(requestedUrl, finalUrl)) {
    return {
      readiness: 'insufficient_context',
      profile: { businessName: null, location: null, services: [], hours: null, sources: [] },
      evidence: { identity: [], services: [], hours: [] },
      gaps: ['same_site_source_unavailable'],
    };
  }

  const sourceUrl = finalUrl;
  const textSentences = [
    ...sentences(description).map((value) => ({ value, field: 'description' })),
    ...sentences(excerpt).map((value) => ({ value, field: 'excerpt' })),
  ];
  const identitySource = identityFromPage(title, siteName);
  const businessName = identitySource?.value ?? null;
  const identity = businessName ? [sourceEvidence(sourceUrl, identitySource.field, identitySource.quote)] : [];
  if (businessName) {
    const corroboration = textSentences.find(({ value }) => value.toLowerCase().includes(businessName.toLowerCase()));
    if (corroboration) identity.push(sourceEvidence(sourceUrl, corroboration.field, corroboration.value));
  }

  const services = [];
  const serviceEvidence = [];
  for (const [name, pattern] of SERVICE_TERMS) {
    const sentence = textSentences.find(({ value }) => {
      const match = pattern.exec(value);
      if (!match) return false;
      // A negative immediately preceding a service is not evidence it is sold.
      const before = value.slice(Math.max(0, match.index - 35), match.index);
      const after = value.slice(match.index + match[0].length, match.index + match[0].length + 40);
      return !NEGATED_SERVICE.test(before) && !NEGATED_AFTER_SERVICE.test(after);
    });
    if (!sentence) continue;
    const citation = sourceEvidence(sourceUrl, sentence.field, sentence.value);
    services.push({ name, sourceUrl, evidence: sentence.value });
    serviceEvidence.push({ name, ...citation });
  }

  const hoursSentence = textSentences.find(({ value }) => HOURS_PATTERN.test(value));
  const hoursMatch = hoursSentence?.value.match(HOURS_PATTERN);
  const hoursEvidence = hoursMatch ? [sourceEvidence(sourceUrl, hoursSentence.field, hoursSentence.value)] : [];
  const hours = hoursMatch
    ? { label: hoursMatch[0], basis: 'published', sourceUrl, evidence: hoursSentence.value }
    : null;

  const gaps = [];
  if (!businessName) gaps.push('business_identity_unverified');
  if (!services.length) gaps.push('service_unverified');
  if (!hours) gaps.push('hours_unknown');
  // One inspected page cannot establish that other pages were crawled or that
  // business identity was independently confirmed.
  if (businessName && services.length && identity.length < 2) gaps.push('business_identity_needs_confirmation');

  const readiness = !businessName || !services.length
    ? 'insufficient_context'
    : identity.length >= 2 ? 'ready' : 'limited_ready';

  return {
    readiness,
    profile: {
      businessName,
      location: null,
      services,
      hours,
      sources: [{ url: sourceUrl, title: title ?? '' }],
    },
    evidence: { identity, services: serviceEvidence, hours: hoursEvidence },
    gaps,
  };
}

/** Combine only facts supported by pages returned from one bounded crawl. */
export function profileFromCrawl(crawl) {
  const origin = typeof crawl?.origin === 'string' ? crawl.origin : '';
  const pages = (Array.isArray(crawl?.pages) ? crawl.pages : []).slice(0, 10).filter((page) => {
    try {
      return new URL(page.finalUrl).origin === origin && sameSubmittedSite(crawl.requestedUrl, page.finalUrl);
    } catch {
      return false;
    }
  });
  if (!pages.length) return profileFromInspection(null);

  const results = pages.map((page) => profileFromInspection({ ...page, requestedUrl: crawl.requestedUrl }));
  const explicitNames = [...new Set(pages.map((page) => identityCandidate(page.siteName)).filter(Boolean))];
  const inferredNames = [...new Set(results.map((result) => result.profile.businessName).filter(Boolean))];
  let businessName = explicitNames.length === 1 ? explicitNames[0] : null;
  if (!businessName && explicitNames.length === 0) {
    // Interior page titles often contain both a service and the business name.
    // A repeated segment across distinct pages can identify the brand without
    // treating every page's topic as a conflicting business identity.
    const counts = new Map();
    for (const page of pages) {
      for (const candidate of new Set(titleCandidates(page.title))) {
        const key = candidate.toLowerCase();
        const prior = counts.get(key);
        counts.set(key, { name: prior?.name ?? candidate, count: (prior?.count ?? 0) + 1 });
      }
    }
    const repeated = [...counts.values()].filter(({ count }) => count >= 2);
    if (repeated.length === 1) businessName = repeated[0].name;
    else if (!repeated.length && inferredNames.length === 1) businessName = inferredNames[0];
  }
  const identity = businessName ? pages.flatMap((page, index) => {
    const pageName = identityCandidate(page.siteName);
    const candidates = titleCandidates(page.title);
    const same = (value) => value?.toLowerCase() === businessName.toLowerCase();
    const source = same(pageName)
      ? sourceEvidence(page.finalUrl, 'siteName', page.siteName)
      : candidates.some(same) ? sourceEvidence(page.finalUrl, 'title', page.title) : null;
    const corroboration = results[index].evidence.identity.filter((item) =>
      same(results[index].profile.businessName) && item.field !== source?.field);
    return [...(source ? [source] : []), ...corroboration];
  }) : [];
  const serviceMap = new Map();
  const evidenceServices = new Map();
  for (const result of results) {
    for (const service of result.profile.services) {
      if (!serviceMap.has(service.name)) serviceMap.set(service.name, service);
    }
    for (const evidence of result.evidence.services) {
      if (!evidenceServices.has(evidence.name)) evidenceServices.set(evidence.name, evidence);
    }
  }
  const hours = results.map((result) => result.profile.hours).filter(Boolean);
  const uniqueHours = [...new Set(hours.map((value) => value.label.toLowerCase()))];
  const supportedHours = uniqueHours.length === 1 ? hours[0] : null;
  const gaps = [];
  if (!businessName) gaps.push(explicitNames.length > 1 || inferredNames.length > 1 ? 'business_identity_conflict' : 'business_identity_unverified');
  if (!serviceMap.size) gaps.push('service_unverified');
  if (!supportedHours) gaps.push(uniqueHours.length > 1 ? 'hours_need_review' : 'hours_unknown');
  if (businessName && identity.length < 2) gaps.push('business_identity_needs_confirmation');

  return {
    readiness: !businessName || !serviceMap.size ? 'insufficient_context' : identity.length >= 2 ? 'ready' : 'limited_ready',
    profile: {
      businessName,
      location: null,
      services: [...serviceMap.values()],
      hours: supportedHours,
      sources: pages.map((page) => ({ url: page.finalUrl, title: page.title ?? '' })),
    },
    evidence: {
      identity,
      services: [...evidenceServices.values()],
      hours: supportedHours ? results.flatMap((result) => result.evidence.hours).filter((item) => item.sourceUrl === supportedHours.sourceUrl) : [],
    },
    gaps,
  };
}

export async function prepareBusinessFromWebsite(url, options = {}) {
  if (options.inspect) {
    const inspection = await options.inspect(url, options.inspectionOptions);
    return profileFromInspection(inspection);
  }
  const crawl = options.crawl ?? researchWebsiteWithExa;
  const research = await crawl(url, options.crawlOptions);
  const compatible = profileFromCrawl(research);
  const richEnabled = options.researchPipeline === true || (options.researchPipeline !== false && !options.crawl && process.env.TYPESAFE_API_KEY && (process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY));
  if (!richEnabled) return compatible;
  const classify = options.classify ?? createJevClassifier(options.jevOptions);
  const extract = options.extract ?? createStructuredExtractor(options.extractionOptions);
  let assessFit = options.assessFit;
  // A test that supplies its own extractor gets no fit label unless it asks, so it never makes a paid request.
  if (assessFit === undefined && !options.extract) try { assessFit = createBusinessFitAssessor(options.fitOptions); } catch { assessFit = null; }
  // Runs beside the knowledge build, so onboarding takes no longer.
  const fitting = assessBusinessFit(research, assessFit);
  try {
    const [sourceKnowledge, businessFit] = await Promise.all([buildSourceGroundedProfile(research, { classify, extract, observedAt: options.observedAt }), fitting]);
    const eligible = sourceKnowledge.eligibleFacts.filter((fact) => fact.eligibility === 'eligible');
    const passageById = new Map();
    for (const passage of sourceKnowledge.classifiedPassages) passageById.set(passage.passageId, passage);
    const sourceFor = (fact) => passageById.get(fact.passageIds[0]);
    const identityFacts = eligible.filter((fact) => sourceKnowledge.identityFactIds.includes(fact.factId));
    const identities = [...new Set(identityFacts.map((fact) => String(fact.value).trim()))];
    const identity = identities.length === 1 ? identityFacts[0] : null;
    const serviceFacts = eligible.filter((fact) => fact.group === 'services');
    const officeHours = eligible.filter((fact) => fact.group === 'office_hours');
    const sourceEntry = (fact) => ({ sourceUrl: sourceFor(fact)?.source.url, quote: sourceFor(fact)?.text, field: 'source_passage' });
    const enrichedProfile = {
      businessName: identity ? String(identity.value) : null,
      location: null,
      services: serviceFacts.map((fact) => ({ id: fact.factId, name: String(fact.value), sourceUrl: sourceFor(fact)?.source.url, evidence: sourceFor(fact)?.text })),
      // When the model finds no office hours, the hours printed on the page are kept. A-1 Heating and Cooling's
      // "Monday - Friday: 8am - 5pm" reached calls as unknown hours, so Blake promised a callback on a Sunday.
      hours: officeHours.length ? { label: officeHours.map((fact) => String(fact.value)).join('; '), basis: 'published_office_hours', sourceUrl: sourceFor(officeHours[0])?.source.url, evidence: officeHours.map((fact) => sourceFor(fact)?.text).join('\n') } : compatible.profile.hours,
      sources: compatible.profile.sources,
    };
    const modelReady = Boolean(identity && serviceFacts.length);
    const gaps = [];
    if (!identity) gaps.push(identities.length > 1 ? 'business_identity_conflict' : 'business_identity_unverified');
    if (!serviceFacts.length) gaps.push('service_unverified');
    if (!enrichedProfile.hours) gaps.push('hours_unknown');
    if (sourceKnowledge.eligibleFacts.some((fact) => fact.eligibility !== 'eligible')) gaps.push('source_information_needs_review');
    return {
      readiness: modelReady ? (gaps.length ? 'limited_ready' : 'ready') : 'insufficient_context',
      profile: enrichedProfile,
      evidence: { identity: identity ? [sourceEntry(identity)] : [], services: serviceFacts.map(sourceEntry), hours: officeHours.map(sourceEntry) },
      sourceKnowledge, groupedFacts: sourceKnowledge.eligibleFacts, groupedProfile: sourceKnowledge.groupedProfile, gaps, businessFit,
    };
  } catch (error) {
    // No credit or a refused key will not clear on its own, so it reaches the visitor as "contact the Frontline team"
    // instead of looking like a website without enough detail.
    if (options.throwOnModelFailure || error?.accountUnavailable || error?.cause?.accountUnavailable) throw error;
    return { readiness: 'insufficient_context', profile: { businessName: null, location: null, services: [], hours: null, sources: compatible.profile.sources }, evidence: { identity: [], services: [], hours: [] }, sourceKnowledge: { state: 'fetch_failure', passages: [], classifiedPassages: [], eligibleFacts: [], groupedProfile: null, identityFactIds: [] }, groupedFacts: [], groupedProfile: null, gaps: ['model_extraction_fetch_failure'], businessFit: await fitting };
  }
}
