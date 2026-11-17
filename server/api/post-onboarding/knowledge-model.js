import { createHash, randomUUID } from 'node:crypto';
import { problem } from './errors.js';

// Owner-editable working knowledge (technical spec, Data model). Everything here is a pure
// function of JSON state: no I/O, no clock unless `now` is passed, no randomness except ids
// from `newId`, so every rule is testable and a write can be computed inside a transaction.

export const ENTRY_GROUPS = ['identity_contact', 'services', 'office_hours', 'service_hours', 'appointment_hours', 'locations_service_area', 'pricing_quote_policy', 'booking_cancellation_policy', 'faq', 'other'];
// Groups that hold several different values at once (a name, a phone number and an address are all business details).
// Only the other groups can conflict: two different office hours for the same slot cannot both be true.
const MULTI_VALUED_GROUPS = ['identity_contact', 'services', 'faq', 'other', 'pricing_quote_policy', 'booking_cancellation_policy', 'locations_service_area'];
export const HOURS_GROUPS = ['office_hours', 'service_hours', 'appointment_hours'];
export const CATEGORY_OF_GROUP = {
  identity_contact: 'business_details', services: 'services', office_hours: 'hours', service_hours: 'hours', appointment_hours: 'hours',
  locations_service_area: 'locations_service_area', pricing_quote_policy: 'pricing', booking_cancellation_policy: 'policies', faq: 'faqs', other: 'other',
};
// Display order and names (design spec PO-S3).
export const CATEGORIES = [
  ['business_details', 'Business details'], ['services', 'Services'], ['hours', 'Hours'], ['locations_service_area', 'Locations & service area'],
  ['pricing', 'Pricing'], ['policies', 'Policies'], ['faqs', 'FAQs'], ['other', 'Other'],
];
// Source `origin` for a source created from the website the owner gave during onboarding (multi-receptionist spec, Default source).
export const ONBOARDING_ORIGIN = 'onboarding_website';
export const ORIGINS = ['website', 'owner_form', 'owner_text', 'owner_dictation', 'owner_document', 'owner_url'];
export const LIMITS = { entries: 500, sources: 500, updates: 200, candidates: 100, value: 1000, scope: 200, excerpt: 600, label: 120 };
const HOSTILE = /(?:ignore|disregard).{0,30}(?:instruction|prompt)|system\s+(?:message|prompt)|developer\s+message|(?:you|assistant)\s+must\s+(?:say|claim|pretend|obey)|fabricate/i;

export const normalizeValue = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const digest = (text) => createHash('sha256').update(text).digest('hex');
const iso = (now) => now.toISOString();

/** Generates ids; injectable so tests can predict them. */
export const defaultId = /** @type {() => string} */ (() => randomUUID());

const fail = (status, code, message, extra = {}) => Object.assign(problem(status, code, message), extra);

export const emptyKnowledgeBase = (materializedFromKnowledgeRevisionId = null) => ({ entries: {}, sources: {}, retractions: [], updates: {}, materializedFromKnowledgeRevisionId });

// ------------------------------------------------------------------ seeding

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return 'website'; } };

/**
 * Builds the working knowledge from the website research the agent was made from.
 * Deterministic (entry id = fact id), so seeding twice gives the same result. Facts the
 * research did not accept (unknown, stale) are not entries; see notUsedByBob.
 */
export function seedKnowledgeBase(knowledgeRecord) {
  const base = emptyKnowledgeBase(knowledgeRecord?.id ?? null);
  if (!knowledgeRecord) return base;
  const passages = new Map((knowledgeRecord.classifiedPassages ?? []).map((passage) => [passage.passageId, passage]));
  for (const fact of knowledgeRecord.groupedFacts ?? []) {
    if (!['eligible', 'conflicting'].includes(fact.eligibility) || !ENTRY_GROUPS.includes(fact.group)) continue;
    const passage = fact.passageIds.map((id) => passages.get(id)).find(Boolean);
    const sourceId = passage?.source?.sourceId ?? fact.passageIds[0];
    if (passage && !base.sources[sourceId]) {
      base.sources[sourceId] = { sourceId, type: 'website', origin: ONBOARDING_ORIGIN, label: hostOf(passage.source.url).slice(0, LIMITS.label), excerpt: String(passage.text).slice(0, LIMITS.excerpt), url: passage.source.url, filename: null, contentHash: digest(passage.text), addedAt: passage.source.retrievedAt, erasedAt: null };
    }
    base.entries[fact.factId] = {
      entryId: fact.factId, category: CATEGORY_OF_GROUP[fact.group], group: fact.group, value: String(fact.value).slice(0, LIMITS.value), scope: '',
      locationKey: (fact.applicableLocationIds ?? []).join(','), origin: 'website', sourceId, state: 'active', attestation: 'website', supersedesEntryId: null,
      conflictWithEntryIds: [], createdAt: fact.observedAt, updatedAt: fact.observedAt, version: 1,
    };
  }
  for (const entry of Object.values(base.entries)) {
    if (!HOURS_GROUPS.includes(entry.group)) continue;
    const rivals = Object.values(base.entries).filter((other) => other.entryId !== entry.entryId && other.group === entry.group && other.locationKey === entry.locationKey && normalizeValue(other.value) !== normalizeValue(entry.value));
    entry.conflictWithEntryIds = rivals.map((other) => other.entryId);
  }
  return base;
}

/** Facts the research kept out (shown under "Not used by Bob" with a reason). */
export function notUsedFacts(knowledgeRecord) {
  return (knowledgeRecord?.groupedFacts ?? []).filter((fact) => !['eligible', 'conflicting'].includes(fact.eligibility) && ENTRY_GROUPS.includes(fact.group))
    .map((fact) => ({ entryId: fact.factId, category: CATEGORY_OF_GROUP[fact.group], group: fact.group, value: String(fact.value).slice(0, LIMITS.value), eligibilityReason: fact.eligibilityReason, origin: 'website' }));
}

// ------------------------------------------------------------------ reading

export function activeEntries(base) { return Object.values(base.entries).filter((entry) => entry.state === 'active'); }

export function publicEntry(entry, base) {
  const source = base.sources[entry.sourceId];
  return { ...entry, sourceLabel: source?.label ?? null, sourceExcerpt: source?.excerpt ?? null, sourceUrl: source?.url ?? null, sourceFilename: source?.filename ?? null, sourceErased: Boolean(source?.erasedAt), hasConflict: entry.conflictWithEntryIds.some((id) => base.entries[id]?.state === 'active') };
}

export function categoriesView(base, notUsed = []) {
  const active = activeEntries(base).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId));
  return CATEGORIES.map(([category, label]) => ({
    category, label,
    entries: active.filter((entry) => entry.category === category).map((entry) => publicEntry(entry, base)),
    notUsedByBob: notUsed.filter((entry) => entry.category === category),
  }));
}

// ------------------------------------------------------------------ validation and flags

function cleanValue(value, field = 'value') {
  if (typeof value !== 'string') throw fail(400, 'invalid_field', `${field}: send text.`);
  const text = value.trim();
  if (!text || text.length > LIMITS.value) throw fail(400, 'invalid_field', `${field}: use 1 to ${LIMITS.value} characters.`);
  if (HOSTILE.test(text)) throw fail(422, 'invalid_field', `${field}: that text looks like an instruction to the assistant, not business information.`);
  return text;
}
function cleanScope(scope) {
  if (scope == null) return '';
  if (typeof scope !== 'string' || scope.trim().length > LIMITS.scope) throw fail(400, 'invalid_field', `scope: use up to ${LIMITS.scope} characters.`);
  return scope.trim();
}
const scopeKey = (scope) => normalizeValue(scope);

/** Flags a candidate against the current entries and retractions (owner review shows these). */
export function flagCandidate(base, candidate) {
  const flags = new Set(candidate.flags ?? []);
  const key = normalizeValue(candidate.value);
  const sKey = scopeKey(candidate.scope);
  const sameSlot = activeEntries(base).filter((entry) => entry.group === candidate.group && (entry.scope ? scopeKey(entry.scope) : entry.locationKey ? `#${entry.locationKey}` : '') === sKey && entry.entryId !== candidate.targetEntryId);
  if (candidate.action !== 'remove') {
    if (sameSlot.some((entry) => normalizeValue(entry.value) === key)) flags.add('duplicate');
    if (candidate.action === 'add' && MULTI_VALUED_GROUPS.includes(candidate.group) === false && sameSlot.some((entry) => normalizeValue(entry.value) !== key)) flags.add('conflicts_with_active');
    if (base.retractions.some((item) => item.group === candidate.group && item.valueKey === key && item.scopeKey === sKey)) flags.add('previously_removed');
  }
  return { ...candidate, flags: [...flags], conflictEntryIds: candidate.action === 'add' && flags.has('conflicts_with_active') ? sameSlot.filter((entry) => normalizeValue(entry.value) !== key).map((entry) => entry.entryId) : [] };
}

function buildCandidate(base, input, newId) {
  if (!['add', 'replace', 'remove'].includes(input.action)) throw fail(400, 'invalid_field', 'op: use add, replace or remove.');
  if (!ENTRY_GROUPS.includes(input.group)) throw fail(400, 'invalid_field', `group: use one of ${ENTRY_GROUPS.join(', ')}.`);
  const target = input.targetEntryId ? base.entries[input.targetEntryId] : null;
  if (input.action !== 'add' && (!target || target.state !== 'active')) throw fail(404, 'not_found', 'That item is no longer in the list.');
  if (target && target.group !== input.group && input.action === 'replace') throw fail(400, 'invalid_field', 'group: an item stays in its own category.');
  const value = input.action === 'remove' ? target.value : cleanValue(input.value);
  const scope = input.action === 'remove' ? target.scope : cleanScope(input.scope);
  return flagCandidate(base, {
    candidateId: newId(), action: input.action, targetEntryId: target?.entryId ?? null, group: input.group, value, scope, sourceId: input.sourceId,
    quote: String(input.quote ?? value).slice(0, LIMITS.value), flags: input.flags ?? [], decision: 'pending', editedValue: null,
  });
}

// ------------------------------------------------------------------ updates

const touch = (update, now) => ({ ...update, version: update.version + 1, updatedAt: iso(now) });

function withUpdate(base, update) {
  const updates = { ...base.updates, [update.updateId]: update };
  const terminal = Object.values(updates).filter((item) => ['applied', 'failed', 'cancelled'].includes(item.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const old of terminal.slice(0, Math.max(0, Object.keys(updates).length - LIMITS.updates))) delete updates[old.updateId];
  return { ...base, updates };
}

function newSource(type, { label, excerpt = '', url = null, filename = null, text = '' }, now, newId) {
  return { sourceId: newId(), type, label: String(label).slice(0, LIMITS.label), excerpt: String(excerpt).slice(0, LIMITS.excerpt), url, filename, contentHash: digest(text || excerpt || label), addedAt: iso(now), erasedAt: null };
}

/** Owner form edit: one candidate, straight to review (no extraction). */
export function createFormUpdate(base, input, { lineage, idempotencyKey, now = new Date(), newId = defaultId }) {
  const source = newSource('owner_form', { label: 'Your note', excerpt: input.value ?? '', text: input.value ?? '' }, now, newId);
  const candidate = buildCandidate(base, { ...input, sourceId: source.sourceId }, newId);
  const update = {
    updateId: newId(), inputType: 'form', inputRef: {}, baseAgentVersionId: lineage.currentAgentVersionId, basePointerGeneration: lineage.pointerGeneration,
    state: 'review', version: 1, candidates: [candidate], leaseExpiresAt: null, failureCode: null, idempotencyKey, createdAt: iso(now), updatedAt: iso(now), appliedAgentVersionId: null,
  };
  return { base: withUpdate({ ...base, sources: { ...base.sources, [source.sourceId]: source } }, update), update };
}

/** Text, dictation, document or URL input: the update waits in `extracting` until candidates arrive. */
export function createExtractingUpdate(base, { inputType, inputRef = {}, lineage, idempotencyKey, now = new Date(), newId = defaultId, leaseSeconds = 90 }) {
  if (!['text', 'dictation', 'document', 'url'].includes(inputType)) throw fail(400, 'invalid_field', 'inputType: use form, text, dictation, document or url.');
  const update = {
    updateId: newId(), inputType, inputRef, baseAgentVersionId: lineage.currentAgentVersionId, basePointerGeneration: lineage.pointerGeneration,
    state: 'extracting', version: 1, candidates: [], leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(), failureCode: null,
    idempotencyKey, createdAt: iso(now), updatedAt: iso(now), appliedAgentVersionId: null,
  };
  return { base: withUpdate(base, update), update };
}

/**
 * Extraction finished. `proposed` are the extractor's facts: { group, value, scope, quote, uncertain? }.
 * Only facts whose quote appears verbatim in the input text are kept (technical spec PO-TD5), the
 * rest are dropped, so a model cannot introduce text the owner never wrote.
 */
export function completeExtraction(base, updateId, { sourceType, sourceLabel, sourceText, url = null, filename = null, proposed }, { now = new Date(), newId = defaultId } = {}) {
  const update = base.updates[updateId];
  if (!update || update.state !== 'extracting') throw fail(409, 'stale_update', 'This update is no longer waiting for extraction.');
  const source = newSource(sourceType, { label: sourceLabel, excerpt: sourceText, url, filename, text: sourceText }, now, newId);
  const haystack = normalizeValue(sourceText);
  const candidates = [];
  for (const fact of (Array.isArray(proposed) ? proposed : []).slice(0, LIMITS.candidates)) {
    if (!ENTRY_GROUPS.includes(fact?.group) || typeof fact.value !== 'string' || typeof fact.quote !== 'string') continue;
    if (!haystack.includes(normalizeValue(fact.quote)) || HOSTILE.test(fact.value) || !fact.value.trim() || fact.value.length > LIMITS.value) continue;
    candidates.push(flagCandidate(base, {
      candidateId: newId(), action: 'add', targetEntryId: null, group: fact.group, value: fact.value.trim(), scope: String(fact.scope ?? '').trim().slice(0, LIMITS.scope), sourceId: source.sourceId,
      quote: fact.quote.trim().slice(0, LIMITS.value), flags: fact.uncertain ? ['model_uncertain'] : [], decision: 'pending', editedValue: null,
    }));
  }
  const next = touch({ ...update, state: 'review', candidates, leaseExpiresAt: null, inputRef: {} }, now);
  return { base: withUpdate({ ...base, sources: { ...base.sources, [source.sourceId]: source } }, next), update: next };
}

export function failExtraction(base, updateId, failureCode, now = new Date()) {
  const update = base.updates[updateId];
  if (!update || !['extracting', 'needs_confirmation'].includes(update.state)) throw fail(409, 'stale_update', 'This update is no longer waiting for extraction.');
  const next = touch({ ...update, state: 'failed', failureCode, leaseExpiresAt: null, inputRef: {} }, now);
  return { base: withUpdate(base, next), update: next };
}

/** A worker died mid-extraction: the lease lapsed, so the update becomes failed and nothing changed. */
export function expireLeases(base, now = new Date()) {
  let next = base;
  for (const update of Object.values(base.updates)) {
    if (update.state === 'extracting' && update.leaseExpiresAt && Date.parse(update.leaseExpiresAt) <= now.getTime()) next = failExtraction(next, update.updateId, 'extraction_interrupted', now).base;
  }
  return next;
}

export function cancelUpdate(base, updateId, expectedVersion, now = new Date()) {
  const update = base.updates[updateId];
  if (!update) throw fail(404, 'not_found', 'Update not found.');
  if (update.version !== expectedVersion || !['extracting', 'needs_confirmation', 'review', 'conflict'].includes(update.state)) throw fail(409, 'stale_update', 'This update changed. Refresh and try again.');
  const next = touch({ ...update, state: 'cancelled', leaseExpiresAt: null }, now);
  return { base: withUpdate(base, next), update: next };
}

/**
 * Applies the owner's decisions to the entries. It does not publish; the caller publishes the
 * resulting entries as a new revision in the same transaction (lineage.publishRevision).
 * decisions: [{ candidateId, decision: 'accept'|'reject'|'edited', editedValue?, resolution?: 'replace_existing'|'keep_both' }]
 */
export function applyUpdate(base, updateId, { expectedVersion, decisions }, { now = new Date(), newId = defaultId } = {}) {
  const update = base.updates[updateId];
  if (!update) throw fail(404, 'not_found', 'Update not found.');
  if (update.state === 'applied') throw fail(409, 'already_applied', 'These changes were already applied.');
  if (update.version !== expectedVersion || update.state !== 'review') throw fail(409, 'stale_update', 'This update changed. Refresh and try again.');
  const byId = new Map((Array.isArray(decisions) ? decisions : []).map((item) => [item?.candidateId, item]));
  const entries = structuredClone(base.entries);
  const retractions = [...base.retractions];
  let accepted = 0;
  const resolved = update.candidates.map((candidate) => {
    const choice = byId.get(candidate.candidateId);
    if (!choice || !['accept', 'reject', 'edited'].includes(choice.decision)) throw fail(400, 'invalid_field', 'decisions: choose Use this, Skip or Edit first for every change.');
    return { candidate, choice };
  });
  for (const { candidate, choice } of resolved) {
    if (choice.decision === 'reject') continue;
    const value = choice.decision === 'edited' ? cleanValue(choice.editedValue, 'editedValue') : candidate.value;
    // Recheck against the entries as they stand now, not as they stood when the update was created.
    const fresh = flagCandidate({ ...base, entries }, { ...candidate, value });
    const conflicting = (fresh.conflictEntryIds ?? []).filter((id) => entries[id]?.state === 'active');
    if (candidate.action === 'add' && conflicting.length && !['replace_existing', 'keep_both'].includes(choice.resolution)) {
      throw fail(422, 'conflict_unresolved', 'Resolve the conflicting items first.', { candidateId: candidate.candidateId });
    }
    const entryFor = (targetId) => ({
      entryId: targetId ?? newId(), category: CATEGORY_OF_GROUP[candidate.group], group: candidate.group, value, scope: candidate.scope, locationKey: '',
      origin: base.sources[candidate.sourceId]?.type ?? 'owner_form', sourceId: candidate.sourceId, state: 'active', attestation: 'owner', supersedesEntryId: null,
      conflictWithEntryIds: [], createdAt: iso(now), updatedAt: iso(now), version: 1,
    });
    if (candidate.action === 'remove') {
      const target = entries[candidate.targetEntryId];
      if (!target || target.state !== 'active') throw fail(409, 'stale_update', 'An item you removed was already changed.');
      entries[target.entryId] = { ...target, state: 'retracted', updatedAt: iso(now), version: target.version + 1 };
      retractions.push({ retractionId: newId(), group: target.group, valueKey: normalizeValue(target.value), scopeKey: scopeKey(target.scope), entryId: target.entryId, retractedAt: iso(now) });
    } else if (candidate.action === 'replace') {
      const target = entries[candidate.targetEntryId];
      if (!target || target.state !== 'active') throw fail(409, 'stale_update', 'An item you changed was already changed.');
      const next = { ...entryFor(newId()), supersedesEntryId: target.entryId };
      entries[target.entryId] = { ...target, state: 'retracted', updatedAt: iso(now), version: target.version + 1 };
      entries[next.entryId] = next;
    } else {
      if (fresh.flags.includes('duplicate')) { accepted += 0; continue; }
      const next = entryFor(newId());
      if (choice.resolution === 'replace_existing') {
        for (const id of conflicting) {
          entries[id] = { ...entries[id], state: 'retracted', updatedAt: iso(now), version: entries[id].version + 1 };
          retractions.push({ retractionId: newId(), group: entries[id].group, valueKey: normalizeValue(entries[id].value), scopeKey: scopeKey(entries[id].scope), entryId: id, retractedAt: iso(now) });
        }
        next.supersedesEntryId = conflicting[0] ?? null;
      }
      entries[next.entryId] = next;
    }
    accepted += 1;
  }
  if (Object.values(entries).filter((entry) => entry.state === 'active').length > LIMITS.entries) throw fail(422, 'input_too_large', `Blake can hold up to ${LIMITS.entries} items.`);
  const applying = touch({ ...update, state: 'applying', candidates: update.candidates.map((candidate) => { const choice = byId.get(candidate.candidateId); return { ...candidate, decision: choice.decision, editedValue: choice.decision === 'edited' ? String(choice.editedValue).trim() : null }; }) }, now);
  return { base: withUpdate({ ...base, entries, retractions }, applying), update: applying, changedCount: accepted };
}

/** Marks the update applied once the new revision is published. */
export function markApplied(base, updateId, appliedAgentVersionId, now = new Date()) {
  const update = base.updates[updateId];
  const next = touch({ ...update, state: 'applied', appliedAgentVersionId }, now);
  return { base: withUpdate(base, next), update: next };
}

/** The base moved (another edit published first): candidates are kept and re-flagged, never silently reapplied. */
export function markConflict(base, updateId, now = new Date()) {
  const update = base.updates[updateId];
  const next = touch({ ...update, state: 'conflict', candidates: update.candidates.map((candidate) => flagCandidate(base, { ...candidate, decision: 'pending', editedValue: null })) }, now);
  return { base: withUpdate(base, next), update: next };
}

/** Re-bases a conflicted update onto the current revision so the owner can review it again. */
export function reopenReview(base, updateId, lineage, now = new Date()) {
  const update = base.updates[updateId];
  if (!update || update.state !== 'conflict') throw fail(409, 'stale_update', 'This update changed. Refresh and try again.');
  const next = touch({ ...update, state: 'review', baseAgentVersionId: lineage.currentAgentVersionId, basePointerGeneration: lineage.pointerGeneration, candidates: update.candidates.map((candidate) => flagCandidate(base, candidate)) }, now);
  return { base: withUpdate(base, next), update: next };
}

export function publicUpdate(update) {
  return { updateId: update.updateId, inputType: update.inputType, state: update.state, version: update.version, baseAgentVersionId: update.baseAgentVersionId, basePointerGeneration: update.basePointerGeneration, candidates: update.candidates, failureCode: update.failureCode, appliedAgentVersionId: update.appliedAgentVersionId, createdAt: update.createdAt, updatedAt: update.updatedAt };
}
