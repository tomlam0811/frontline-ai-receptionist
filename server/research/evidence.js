import { uuidFor } from './passages.js';

const normalize = (value) => String(value).toLowerCase().replace(/\s+/g, ' ').trim();
const HOSTILE = /(?:ignore|disregard).{0,30}(?:instruction|prompt)|system\s+(?:message|prompt)|developer\s+message|(?:you|assistant)\s+must\s+(?:say|claim|pretend|obey)|\bfabricate\s+(?:an?\s+|the\s+|some\s+)?(?:facts?|information|answers?|claims?|details|reviews?|testimonials?|data)\b/i;
const STALE = /\b(?:archived|superseded|expired|no longer current)\b/i;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HOUR_GROUPS = ['office_hours', 'service_hours', 'appointment_hours'];

function matchingStatements(passage, value) {
  return passage.text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => normalize(sentence).includes(normalize(value)));
}

// The page classifier misses categories on real sites: on 2026-10-02 it gave portplastics.com's home page no category
// and its contact page only "services", so its name, phone and services were all refused although each was quoted
// word for word. For these groups a verbatim, non-negated quote is enough. Hours and policies keep the category check,
// because a quoted line is easily the wrong kind of hours or policy.
const QUOTE_IS_ENOUGH = new Set(['identity_contact', 'services', 'locations_service_area']);

function supports(passage, fact) {
  if (HOSTILE.test(passage.text)) return false;
  if (!QUOTE_IS_ENOUGH.has(fact.group) && !passage.classifications?.includes(fact.group)) return false;
  return matchingStatements(passage, fact.value).some((sentence) => {
    // A verbatim mention inside a denial is not an offered service or policy.
    if (/\b(?:not|never|no longer|do not|does not|don't|doesn't|cannot|can't|unavailable|discontinued)\b/i.test(sentence)) return false;
    if (fact.group === 'office_hours' && !/\b(?:office|business hours|opening hours|open|closed)\b/i.test(sentence)) return false;
    if (fact.group === 'service_hours' && !/\b(?:crew|service|cleaning|operations?|work)\b/i.test(sentence)) return false;
    if (fact.group === 'appointment_hours' && !/\b(?:appointment|booking|calendar|reservation)\b/i.test(sentence)) return false;
    return true;
  });
}

function dayScope(fact, cited) {
  const context = cited.flatMap((passage) => matchingStatements(passage, fact.value)).join(' ').toLowerCase();
  const days = DAYS.flatMap((day, index) => context.includes(day) ? [index] : []);
  const range = context.match(/(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*(?:through|to|[-–])\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (range) { let i = DAYS.indexOf(range[1]); do { days.push(i); if (i === DAYS.indexOf(range[2])) break; i = (i + 1) % 7; } while (days.length < 16); }
  return [...new Set(days)];
}

export function admitExtractedFacts(extracted, passages, observedAt = new Date().toISOString()) {
  const byId = new Map(passages.map((passage) => [passage.passageId, passage]));
  const candidates = (Array.isArray(extracted) ? extracted : []).slice(0, 100).map((fact) => {
    const ids = Array.isArray(fact?.passageIds) ? [...new Set(fact.passageIds)] : [];
    const cited = ids.map((id) => byId.get(id)).filter(Boolean);
    const valid = typeof fact?.value === 'string' && fact.value.trim().length > 0 && fact.value.length <= 1000;
    // One cited page that states it is enough; a fact repeated across pages is not refused because one page's
    // classification missed it.
    const supported = valid && ids.length > 0 && cited.length === ids.length && cited.some((passage) => supports(passage, fact));
    const stale = cited.some((passage) => STALE.test(passage.text));
    const scope = typeof fact.scope === 'string' ? fact.scope.trim() : '';
    const scopeSupported = !scope || cited.every((passage) => normalize(passage.text).includes(normalize(scope)));
    return { fact, cited, supported: supported && scopeSupported, stale, scope: normalize(scope), days: dayScope(fact, cited) };
  });
  return candidates.map(({ fact, cited, supported, stale, scope, days }) => {
    const conflicting = supported && !stale && HOUR_GROUPS.includes(fact.group) && candidates.some((other) =>
      other.fact !== fact && other.supported && !other.stale && other.fact.group === fact.group && other.scope === scope
      && (!days.length || !other.days.length || days.some((day) => other.days.includes(day)))
      && normalize(other.fact.value) !== normalize(fact.value));
    const eligibility = !supported ? 'unknown' : stale ? 'stale' : conflicting ? 'conflicting' : 'eligible';
    return Object.freeze({
      factId: uuidFor(`fact:${fact.group}:${fact.value}:${scope}:${[...new Set(fact.passageIds ?? [])].sort().join(',')}`), group: fact.group, value: String(fact.value).slice(0, 1000),
      passageIds: cited.map(({ passageId }) => passageId), applicableServiceIds: [], applicableLocationIds: scope ? [uuidFor(`location:${scope}`)] : [], eligibility,
      eligibilityReason: eligibility === 'eligible' ? 'Direct statement with matching classified category and source context.' : eligibility === 'conflicting' ? 'Current statements disagree in overlapping day and location scope.' : eligibility === 'stale' ? 'Source is explicitly archived, superseded, or expired.' : 'Source category, wording, or scope does not support this claim.',
      observedAt, confidenceEvidence: { score: eligibility === 'eligible' ? 0.9 : 0, basis: cited.length > 1 ? 'corroborated_passages' : 'direct_passage', explanation: eligibility === 'eligible' ? 'Matching category and direct non-negated source wording.' : 'Not eligible for runtime answers.' },
    });
  });
}
