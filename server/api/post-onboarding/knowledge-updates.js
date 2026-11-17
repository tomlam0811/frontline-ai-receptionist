import { createHash } from 'node:crypto';
import { problem } from './errors.js';
import { withOwnerState } from './owner-state.js';
import { backfillKnowledgeLibrary, currentKnowledgeRecord, ensureLineage, publishRevision, readKnowledgeBase, readLineage, versionNumbers } from './lineage.js';
import { isSelectableSource, ownsUpdate, sourcesAddedBy, usedByList } from './knowledge-selection.js';
import { applyUpdate, cancelUpdate, categoriesView, completeExtraction, createExtractingUpdate, createFormUpdate, expireLeases, failExtraction, markApplied, markConflict, notUsedFacts, publicUpdate, reopenReview, LIMITS } from './knowledge-model.js';
import { applyWorkflowToggles, workflowView } from './capabilities.js';
import { listSourceErasures } from './source-erasure.js';
import { receptionistNameOf } from './receptionist-name.js';

// Owner knowledge, capability and review operations (technical spec PO-E2 to PO-E8, PO-E12, PO-E15).
// Every function runs in one owner-scope transaction, so a failure changes nothing (except where
// `thenThrow` is used on purpose to record an update as `conflict`).

const OPEN = ['extracting', 'needs_confirmation', 'review', 'applying', 'conflict'];
const TEXT_MAX = 10_000;
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stale = (lineage) => Object.assign(problem(409, 'stale_agent_version', `${receptionistNameOf(lineage)} changed since you opened this. Refresh and try again.`), { currentPointerGeneration: lineage.pointerGeneration, currentAgentVersionId: lineage.currentAgentVersionId });

function requireKey(idempotencyKey) {
  if (!idempotencyKey) throw problem(400, 'invalid_field', 'Idempotency-Key: send a unique key with this request.');
}

/**
 * Loads the lineage and the business library, expiring lapsed extractions. `leaseChanged` says a lapse was recorded.
 * A scope still on per-agent knowledge is backfilled into the library here (in the returned state; a caller that
 * writes persists it, a plain read does not).
 */
function open(state, actor, now) {
  const ensured = ensureLineage(state, actor.stableAgentId);
  if (!ensured) throw problem(404, 'not_found', 'Not found.');
  const withLineage = backfillKnowledgeLibrary(ensured, actor.stableAgentId);
  const lineage = readLineage(withLineage, actor.stableAgentId);
  const original = readKnowledgeBase(withLineage, actor.stableAgentId);
  const base = expireLeases(original, now);
  return { state: withLineage, lineage, base, leaseChanged: base !== original };
}
const persist = (state, actor, base) => ({ ...state, knowledgeLibrary: base });
/** An update this receptionist did not start is not visible to it. */
const ownUpdate = (base, lineage, updateId) => { const update = base.updates[updateId]; if (!update || !ownsUpdate(lineage, update)) throw problem(404, 'not_found', 'Not found.'); return update; };

function publicSources(base, state) {
  return Object.values(base.sources).filter((source) => !source.erasedAt).map((source) => ({ ...Object.fromEntries(Object.entries(source).filter(([name]) => name !== 'contentHash' && name !== 'erasureJobId')), usedBy: usedByList(state, source.sourceId) }));
}

/** PO-E2 */
export function readKnowledge({ db, actor, now = new Date(), extractionAvailable = /** @type {Record<string, boolean>} */ ({}) }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base, leaseChanged } = open(raw, actor, now);
    const knowledge = currentKnowledgeRecord(state, actor.stableAgentId);
    const result = {
      stableAgentId: actor.stableAgentId, currentAgentVersionId: lineage.currentAgentVersionId, pointerGeneration: lineage.pointerGeneration,
      inputs: { form: true, text: Boolean(extractionAvailable.text), dictation: Boolean(extractionAvailable.text && extractionAvailable.dictation), document: Boolean(extractionAvailable.document), url: Boolean(extractionAvailable.url) },
      sourceIds: lineage.sourceIds ?? [], categories: categoriesView(base, notUsedFacts(knowledge)), sources: publicSources(base, state), sourceErasures: listSourceErasures(state, actor.stableAgentId),
      openUpdates: Object.values(base.updates).filter((update) => OPEN.includes(update.state) && ownsUpdate(lineage, update)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicUpdate),
    };
    // Reading never creates a knowledge base; it persists only a lazy lease expiry.
    return { result, state: leaseChanged ? persist(state, actor, base) : undefined };
  });
}

function checkBase(lineage, body) {
  if (typeof body.baseAgentVersionId !== 'string' || !Number.isInteger(body.expectedPointerGeneration)) throw problem(400, 'invalid_field', 'baseAgentVersionId and expectedPointerGeneration: send the values from the page you are editing.');
  if (lineage.currentAgentVersionId !== body.baseAgentVersionId || lineage.pointerGeneration !== body.expectedPointerGeneration) throw stale(lineage);
}

/**
 * PO-E3 and PO-E4. `body.inputType` is form, text, dictation, document or url. Form updates go straight to
 * review. The others start `extracting`; `onExtract(updateId)` is called after commit so the caller can run
 * the extraction outside the request transaction.
 */
export async function createKnowledgeUpdate({ db, actor, body, idempotencyKey, now = new Date(), extractionAvailable = /** @type {Record<string, boolean>} */ ({}), newId = undefined }) {
  requireKey(idempotencyKey);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  const payloadDigest = digestOf({ ...body, baseAgentVersionId: undefined, expectedPointerGeneration: undefined });
  const inputType = body.inputType;
  if (['text', 'dictation'].includes(inputType)) {
    if (typeof body.text !== 'string' || !body.text.trim()) throw problem(400, 'invalid_field', 'text: write something first.');
    if (body.text.length > TEXT_MAX) throw problem(413, 'input_too_large', `Use up to ${TEXT_MAX.toLocaleString('en-US')} characters.`);
    if (!extractionAvailable.text) throw problem(503, 'extraction_unavailable', 'Reading text is not available right now.');
  } else if (['document', 'url'].includes(inputType)) {
    if (!extractionAvailable[inputType]) throw problem(503, 'extraction_unavailable', 'That kind of source is not available right now.');
  } else if (inputType !== 'form') throw problem(400, 'invalid_field', 'inputType: use form, text, dictation, document or url.');
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base } = open(raw, actor, now);
    const replay = Object.values(base.updates).find((update) => update.idempotencyKey === idempotencyKey && ownsUpdate(lineage, update));
    if (replay) {
      if (replay.payloadDigest !== payloadDigest) throw problem(409, 'idempotency_conflict', 'This request key was already used with different content.');
      return { result: { update: publicUpdate(replay), replayed: true, extractNow: false } };
    }
    checkBase(lineage, body);
    if (Object.values(base.updates).filter((item) => OPEN.includes(item.state) && ownsUpdate(lineage, item)).length >= 5) throw problem(429, 'rate_limited', 'Finish or cancel your open changes first.');
    const options = { lineage, idempotencyKey, now, ...(newId ? { newId } : {}) };
    let made;
    if (inputType === 'form') {
      made = createFormUpdate(base, { action: body.op, group: body.group, value: body.value, scope: body.scope, targetEntryId: body.targetEntryId }, options);
    } else {
      made = createExtractingUpdate(base, { inputType, inputRef: inputType === 'url' ? { url: String(body.url ?? '') } : inputType === 'document' ? { uploadHandle: String(body.uploadHandle ?? '') } : { text: body.text.trim() }, ...options });
    }
    const update = { ...made.update, payloadDigest };
    const next = { ...made.base, updates: { ...made.base.updates, [update.updateId]: update } };
    return { result: { update: publicUpdate(update), replayed: false, extractNow: update.state === 'extracting' }, state: persist(state, actor, next) };
  });
}

/** Runs the extractor for one update and stores the candidates. Errors become a failed update, never a throw. */
export async function runExtraction({ db, actor, updateId, extraction, now = () => new Date(), newId = undefined }) {
  let input;
  await withOwnerState(db, actor.scopeId, (raw) => {
    const base = readKnowledgeBase(raw, actor.stableAgentId);
    const update = base.updates[updateId];
    input = update?.state === 'extracting' ? { inputType: update.inputType, inputRef: update.inputRef } : null;
    return { result: null };
  });
  if (!input) return;
  let outcome;
  try {
    outcome = await extraction.extract(input);
  } catch (error) {
    const code = typeof error?.failureCode === 'string' ? error.failureCode : 'extraction_failed';
    await finishExtraction({ db, actor, updateId, now, fn: (base) => failExtraction(base, updateId, code, now()).base });
    return;
  }
  await finishExtraction({
    db, actor, updateId, now,
    fn: (base) => completeExtraction(base, updateId, {
      sourceType: input.inputType === 'dictation' ? 'owner_dictation' : input.inputType === 'text' ? 'owner_text' : input.inputType === 'url' ? 'owner_url' : 'owner_document',
      sourceLabel: outcome.sourceLabel ?? (input.inputType === 'text' ? 'Typed note' : input.inputType === 'dictation' ? 'Dictated note' : 'Owner source'),
      // For typed and dictated text the haystack is what the owner sent, never what the extractor returns.
      sourceText: ['text', 'dictation'].includes(input.inputType) ? input.inputRef.text : String(outcome.sourceText ?? ''),
      url: outcome.url ?? null, filename: outcome.filename ?? null, proposed: outcome.proposed,
    }, { now: now(), ...(newId ? { newId } : {}) }).base,
  });
}

async function finishExtraction({ db, actor, updateId, now, fn }) {
  await withOwnerState(db, actor.scopeId, (raw) => {
    const { state, base } = open(raw, actor, now());
    if (base.updates[updateId]?.state !== 'extracting') return { result: null };
    return { result: null, state: persist(state, actor, fn(base)) };
  });
}

/** PO-E5 */
export function getKnowledgeUpdate({ db, actor, updateId, now = new Date() }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base, leaseChanged } = open(raw, actor, now);
    const update = ownUpdate(base, lineage, updateId);
    return { result: { update: publicUpdate(update) }, state: leaseChanged ? persist(state, actor, base) : undefined };
  });
}

/** PO-E6. Publishing and marking the update applied happen together, or neither does. */
export function applyKnowledgeUpdate({ db, actor, updateId, body, idempotencyKey, now = new Date(), newId = undefined }) {
  requireKey(idempotencyKey);
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base } = open(raw, actor, now);
    const update = ownUpdate(base, lineage, updateId);
    if (update.state === 'applied') {
      if (update.applyKey === idempotencyKey) return { result: { update: publicUpdate(update), replayed: true } };
      throw problem(409, 'already_applied', 'These changes were already applied.');
    }
    if (update.state === 'review' && (update.baseAgentVersionId !== lineage.currentAgentVersionId || update.basePointerGeneration !== lineage.pointerGeneration)) {
      return { result: null, state: persist(state, actor, markConflict(base, updateId, now).base), thenThrow: stale(lineage) };
    }
    const applying = applyUpdate(base, updateId, { expectedVersion: body?.expectedVersion, decisions: body?.decisions }, { now, ...(newId ? { newId } : {}) });
    // A source the owner just added through this update joins this receptionist's selection.
    const sourceIds = [...new Set([...lineage.sourceIds, ...sourcesAddedBy(base, applying.base)])];
    const published = publishRevision(state, { stableAgentId: actor.stableAgentId, baseAgentVersionId: update.baseAgentVersionId, expectedGeneration: update.basePointerGeneration, knowledgeBase: applying.base, sourceIds, kind: 'knowledge', actorSubjectHash: actor.creatorRef, now, ...(newId ? { newId } : {}) });
    const done = markApplied(applying.base, updateId, published.agentVersionId, now);
    const applied = { ...done.update, applyKey: idempotencyKey };
    const finalBase = { ...done.base, updates: { ...done.base.updates, [updateId]: applied } };
    return { result: { update: publicUpdate(applied), replayed: false, changedCount: applying.changedCount }, state: persist(published.state, actor, finalBase) };
  });
}

/** PO-E7 */
export function cancelKnowledgeUpdate({ db, actor, updateId, body, now = new Date() }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base } = open(raw, actor, now);
    ownUpdate(base, lineage, updateId);
    const done = cancelUpdate(base, updateId, body?.expectedVersion, now);
    return { result: { update: publicUpdate(done.update) }, state: persist(state, actor, done.base) };
  });
}

/** Reopens a conflicted update on the current revision (the owner's "Review again" action). */
export function reopenKnowledgeUpdate({ db, actor, updateId, now = new Date() }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base } = open(raw, actor, now);
    ownUpdate(base, lineage, updateId);
    const done = reopenReview(base, updateId, lineage, now);
    return { result: { update: publicUpdate(done.update) }, state: persist(state, actor, done.base) };
  });
}

/** GET half of PO-E12 (see the deviation in the technical spec: capabilities have their own path until connection). */
export function readCapabilities({ db, actor }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const lineage = readLineage(raw, actor.stableAgentId);
    const agent = lineage && raw.agents?.[lineage.currentAgentVersionId];
    if (!agent) throw problem(404, 'not_found', 'Not found.');
    return { result: { stableAgentId: actor.stableAgentId, currentAgentVersionId: lineage.currentAgentVersionId, pointerGeneration: lineage.pointerGeneration, workflows: workflowView(agent.capabilityManifest, receptionistNameOf(lineage)) } };
  });
}

/** PO-E12: saves the four optional workflows as a new revision. Same compare-and-swap as knowledge apply. */
export function saveCapabilities({ db, actor, body, idempotencyKey, now = new Date(), newId = undefined }) {
  requireKey(idempotencyKey);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  const payloadDigest = digestOf({ workflows: body.workflows });
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base } = open(raw, actor, now);
    // A retry after a lost response finds its own revision by key and returns it, instead of failing as a stale base.
    const replayIndex = lineage.revisions.findIndex((revision) => revision.requestKey === idempotencyKey);
    if (replayIndex >= 0) {
      const replay = lineage.revisions[replayIndex];
      if (replay.payloadDigest !== payloadDigest) throw problem(409, 'idempotency_conflict', 'This request key was already used with different content.');
      return { result: { stableAgentId: actor.stableAgentId, currentAgentVersionId: replay.agentVersionId, pointerGeneration: replayIndex + 1, workflows: workflowView(state.agents[replay.agentVersionId].capabilityManifest, receptionistNameOf(lineage)), replayed: true } };
    }
    checkBase(lineage, body);
    const agent = state.agents?.[lineage.currentAgentVersionId];
    if (!agent) throw problem(404, 'not_found', 'Not found.');
    const workflows = applyWorkflowToggles(agent.capabilityManifest, body.workflows);
    const published = publishRevision(state, { stableAgentId: actor.stableAgentId, baseAgentVersionId: body.baseAgentVersionId, expectedGeneration: body.expectedPointerGeneration, knowledgeBase: base, workflows, kind: 'capabilities', actorSubjectHash: actor.creatorRef, now, ...(newId ? { newId } : {}) });
    const nextAgent = published.state.agents[published.agentVersionId];
    const stored = published.state.agentLineages[actor.stableAgentId];
    const tagged = { ...stored, revisions: stored.revisions.map((revision) => (revision.agentVersionId === published.agentVersionId ? { ...revision, requestKey: idempotencyKey, payloadDigest } : revision)) };
    return { result: { stableAgentId: actor.stableAgentId, currentAgentVersionId: published.agentVersionId, pointerGeneration: published.pointerGeneration, workflows: workflowView(nextAgent.capabilityManifest, receptionistNameOf(lineage)), replayed: false }, state: { ...published.state, agentLineages: { ...published.state.agentLineages, [actor.stableAgentId]: tagged } } };
  });
}

/**
 * PUT /v1/agents/:id/knowledge-sources-selection. Chooses which library sources this receptionist uses and publishes a
 * new version with only those sources (multi-receptionist spec MR-J2, MR-T3). Same compare-and-swap as knowledge apply,
 * keyed on `expectedAgentVersionId`. An empty selection is allowed. `Idempotency-Key` is optional; with one, a retry after
 * a lost response returns the version it published.
 */
export function saveKnowledgeSelection({ db, actor, body, idempotencyKey = null, now = new Date(), newId = undefined }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  if (typeof body.expectedAgentVersionId !== 'string') throw problem(400, 'invalid_field', 'expectedAgentVersionId: send the version from the page you are editing.');
  if (!Array.isArray(body.sourceIds) || body.sourceIds.length > LIMITS.sources || body.sourceIds.some((id) => typeof id !== 'string')) throw problem(400, 'invalid_field', 'sourceIds: send a list of source ids.');
  const sourceIds = [...new Set(body.sourceIds)];
  const payloadDigest = digestOf({ sourceIds: [...sourceIds].sort() });
  const summaryOf = (lineage, agentVersionId, replayed) => ({ stableAgentId: actor.stableAgentId, currentAgentVersionId: agentVersionId, pointerGeneration: lineage.revisions.findIndex((revision) => revision.agentVersionId === agentVersionId) + 1, versionNumber: versionNumbers(lineage)[agentVersionId], sourceIds: lineage.sourceIds, replayed });
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage, base } = open(raw, actor, now);
    const replay = idempotencyKey ? lineage.revisions.find((revision) => revision.requestKey === idempotencyKey) : null;
    if (replay) {
      if (replay.payloadDigest !== payloadDigest) throw problem(409, 'idempotency_conflict', 'This request key was already used with different content.');
      return { result: summaryOf(lineage, replay.agentVersionId, true) };
    }
    if (lineage.currentAgentVersionId !== body.expectedAgentVersionId) throw stale(lineage);
    if (sourceIds.some((id) => !isSelectableSource(base.sources[id]))) throw problem(422, 'invalid_field', 'sourceIds: choose sources from the business list.');
    const published = publishRevision(state, { stableAgentId: actor.stableAgentId, baseAgentVersionId: lineage.currentAgentVersionId, expectedGeneration: lineage.pointerGeneration, knowledgeBase: base, sourceIds, kind: 'knowledge', actorSubjectHash: actor.creatorRef, now, ...(newId ? { newId } : {}) });
    const stored = published.state.agentLineages[actor.stableAgentId];
    const tagged = idempotencyKey ? { ...stored, revisions: stored.revisions.map((revision) => (revision.agentVersionId === published.agentVersionId ? { ...revision, requestKey: idempotencyKey, payloadDigest } : revision)) } : stored;
    return { result: summaryOf(tagged, published.agentVersionId, false), state: { ...published.state, agentLineages: { ...published.state.agentLineages, [actor.stableAgentId]: tagged } } };
  });
}

/** PO-E15: the owner confirms a tested version. A version with no completed test cannot be marked reviewed. */
export function markVersionReviewed({ db, actor, versionId, body, now = new Date() }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const { state, lineage } = open(raw, actor, now);
    if (!Number.isInteger(body?.expectedPointerGeneration)) throw problem(400, 'invalid_field', 'expectedPointerGeneration: send the value from the page you are viewing.');
    if (lineage.pointerGeneration !== body.expectedPointerGeneration) throw stale(lineage);
    const index = lineage.revisions.findIndex((revision) => revision.agentVersionId === versionId);
    if (index < 0) throw problem(404, 'not_found', 'Not found.');
    if (!lineage.revisions[index].lastTestedAt) throw problem(422, 'not_tested', 'Test this version before marking it reviewed.');
    const ownerReviewedAt = lineage.revisions[index].ownerReviewedAt ?? now.toISOString();
    const revisions = lineage.revisions.map((revision, at) => (at === index ? { ...revision, ownerReviewedAt } : revision));
    return { result: { agentVersionId: versionId, ownerReviewedAt }, state: { ...state, agentLineages: { ...state.agentLineages, [actor.stableAgentId]: { ...lineage, revisions } } } };
  });
}

export const KNOWLEDGE_LIMITS = LIMITS;
