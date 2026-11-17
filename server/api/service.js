import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { validateInspectionUrl } from '../website-inspection.js';
import { prepareBusinessFromWebsite } from '../business-preparation.js';
import { createPreparationQueue } from './preparation-queue.js';
import { DevelopmentStore } from './store.js';
import { PostgresStore } from './postgres-store.js';
import { problem, publicPreparation, requireObject, schemaVersion } from './contracts.js';
import { frontlineProductKnowledge } from './knowledge.js';
import { createPaidStartGate } from './paid-start-gate.js';
import { createAuthClaims } from './auth-claims.js';
import { ALL_WORKFLOW_IDS, beginEnding, confirmReadback, disabledWorkflowIds, finishTerminal, forceTerminal, lookupAppointment, recordReadback, recordTurn, saveCase, saveRequest, validateFields } from './workflows.js';
import { publicTask, taskCommand, taskEnd } from './tasks.js';
import { buildCallSummary } from './call-summary.js';
import { createRecapWriter } from './call-recap.js';
import { withNextSteps } from './next-step.js';
import { createJevClassifier } from './jev-classifier.js';
import { validateContract, validateRetrievalResult } from '../../contracts/v1/contract-validator.js';
import { researchConfiguration } from './research-readiness.js';
import { fromPool } from './post-onboarding/database.js';
import { expireDueShares, markShareActive } from './post-onboarding/share.js';
import { createPostOnboardingHandler } from './post-onboarding/routes.js';
import { isCallFenced } from './post-onboarding/source-redaction.js';
import { createOwnerResolver } from './post-onboarding/owner-context.js';
import { DEFAULT_GUEST_CONFIG } from './post-onboarding/guest.js';
import { markOwnerTestCompleted } from './post-onboarding/owner-test.js';
import { readDemo } from './post-onboarding/demo-store.js';
import { businessNameFor, readLineage } from './post-onboarding/lineage.js';
import { receptionistNameOf } from './post-onboarding/receptionist-name.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16_384;
// Feature flag for the post-onboarding slice. Everything it adds stays off unless this is set.
export const postOnboardingEnabled = () => ['1', 'on', 'true'].includes(String(process.env.FRONTLINE_POST_ONBOARDING ?? '').trim().toLowerCase());
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const iso = (time) => new Date(time).toISOString();
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function secureCookieSuffix() {
  if (process.env.NODE_ENV !== 'production') return '';
  try {
    const app = new URL(process.env.APP_BASE_URL);
    if (app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname)) return '';
  } catch { /* An unset production origin retains Secure cookies. */ }
  return '; Secure';
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((entry) => entry.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
}

async function jsonBody(request) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw problem(415, 'unsupported_media_type', 'Send application/json.');
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw problem(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, 'invalid_json', 'Send valid JSON.'); }
}

function respond(response, status, data, requestId, headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-request-id': requestId, ...headers });
  response.end(JSON.stringify({ ...data, requestId, version: schemaVersion }));
}

// Central catch site for every route: this is the only place that needs to log a thrown API error,
// instead of each handler doing it. Deliberately omits error.message/stack: problem() detail text and
// validateContract's TypeError messages can echo caller-supplied values (e.g. "Unknown field: <key>."),
// so only the static status/code/errorName identifiers go to the log, never the message body or request body.
function reject(response, error, requestId, context = {}) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const headers = { 'content-type': 'application/problem+json; charset=utf-8' };
  if (status === 429) headers['retry-after'] = error.code === 'inspection_busy' ? '2' : '60';
  const revisions = {
    ...(Number.isSafeInteger(error.currentWorkflowRevision) && error.currentWorkflowRevision > 0 ? { currentWorkflowRevision: error.currentWorkflowRevision } : {}),
    ...(Number.isSafeInteger(error.currentStateRevision) && error.currentStateRevision > 0 ? { currentStateRevision: error.currentStateRevision } : {}),
  };
  console.error(JSON.stringify({ event: 'api_error', status, code: error.code ?? null,
    errorName: error.code ? null : (error?.name ?? 'Error'), method: context.method ?? null, path: context.path ?? null, requestId }));
  respond(response, status, { type: `https://frontline.invalid/problems/${error.code ?? 'internal_error'}`, title: error.code ?? 'internal_error', detail: status >= 500 ? 'The request could not be completed.' : error.message, status, ...revisions }, requestId, headers);
}

function ownerTargetCookie(kind, id, clear = false) {
  return `fl_owner_target=${clear ? '' : `${kind}.${id}`}; HttpOnly; Path=/; SameSite=Strict${secureCookieSuffix()}; Max-Age=${clear ? 0 : 2592000}`;
}

async function endVoiceBounded(voice, demo, timeoutMs = 2500) {
  if (typeof voice?.end !== 'function') return false;
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => voice.end(demo)).then(() => true),
      new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); timer.unref?.(); }),
    ]);
    return result;
  } catch { return false; /* Persisted terminal state remains authoritative. */ }
  finally { if (timer) clearTimeout(timer); }
}

async function finalizeVoiceCleanup(store, paidStartGate, demo) {
  if (!demo.reservationId) return;
  if (typeof store.finalizeHardEnd === 'function') {
    await store.finalizeHardEnd({ ...demo, ownerScopeId: demo.ownerScopeId ?? demo.workspaceId, deadlinePhase: demo.deadlinePhase ?? (demo.hardEndAt ? 'active' : 'setup') });
    return;
  }
  await paidStartGate?.complete?.(demo.reservationId);
}

// A first cleanup attempt that could not confirm room deletion leaves the reservation held (correctly:
// a room that might still exist must not free the one-call-per-Bob slot). But the only other retry is
// the hard-end watchdog, which does nothing until the call's original multi-minute deadline arrives, so
// an early-ended call with one slow or failed deletion would otherwise sit reserved for the rest of that
// window. This retries a few times over the following seconds so the common case clears promptly, and
// still leaves the watchdog as the backstop if all of these also fail.
function retryVoiceCleanupSoon(voice, store, paidStartGate, demo, delaysMs = [2000, 5000, 10000]) {
  (async () => {
    for (const delayMs of delaysMs) {
      await new Promise((resolve) => { const timer = setTimeout(resolve, delayMs); timer.unref?.(); });
      if (await endVoiceBounded(voice, demo)) {
        try { await finalizeVoiceCleanup(store, paidStartGate, demo); } catch { /* the hard-end watchdog remains the backstop */ }
        return;
      }
    }
  })().catch(() => { /* the hard-end watchdog remains the backstop */ });
}

const OWNER_SOURCE_LABEL = { owner_form: 'Added by you', owner_text: 'Typed by you', owner_dictation: 'Dictated by you', owner_document: 'From a document you added', owner_url: 'From a web page you added' };

// PO-C5 (connection doc: "Blocked ... needs a decision on widening the row"). `compileOwnerKnowledge`
// keeps owner-attested entries out of `groupedFacts`/`classifiedPassages` because that contract requires
// a public https `sourceRef` (PO-F12) and owner text has none. So an owner correction is compiled and
// shown as applied, but nothing made Bob use it on a call: this synthesizes contract-valid
// `classifiedPassage`/`eligibleFact` shapes (using the already-additive `ownerSourceRef` and
// `owner-attested-v1` model, PO-C3) from `knowledge.ownerFacts` at retrieval time only, so an owner's
// saved correction actually reaches the live call without changing what gets persisted.
function ownerFactPassages(knowledge, now) {
  const ownerFacts = Array.isArray(knowledge?.ownerFacts) ? knowledge.ownerFacts : [];
  const passages = []; const facts = [];
  for (const entry of ownerFacts) {
    if (entry?.status !== 'eligible_for_demo' || !entry.value) continue;
    const text = String(entry.evidence ?? entry.value ?? '').trim().slice(0, 12_000);
    if (!text) continue;
    const passageId = randomUUID();
    const retrievedAt = entry.addedAt ?? now;
    const source = { sourceId: entry.sourceId ?? randomUUID(), sourceType: entry.sourceType ?? 'owner_form', label: OWNER_SOURCE_LABEL[entry.sourceType] ?? 'Added by you', retrievedAt, ...(entry.sourceUrl ? { url: entry.sourceUrl } : {}) };
    passages.push({ passageId, source, text, classifications: [entry.group], classificationModel: 'owner-attested-v1' });
    facts.push({
      factId: entry.id, group: entry.group, value: entry.value, passageIds: [passageId],
      applicableServiceIds: [], applicableLocationIds: [], eligibility: 'eligible',
      eligibilityReason: 'Stated by the business owner.', observedAt: retrievedAt,
      confidenceEvidence: { score: 1, basis: 'direct_passage', explanation: 'Stated directly by the business owner.' },
    });
  }
  return { facts, passages };
}

const queryWords = (value) => String(value ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
// The voice worker refuses a runtime bundle over 256 KB. Since the reader keeps whole pages, each fact and service
// carries up to 12,000 characters of evidence, and portplastics.com went over the limit on 2026-10-03, so no call could
// start. The bundle sends the part of the page around each value; lookups during the call still return whole passages.
const BUNDLE_EVIDENCE_CHARACTERS = 1_000;

function evidenceExcerpt(text, value) {
  if (typeof text !== 'string' || text.length <= BUNDLE_EVIDENCE_CHARACTERS) return text;
  const at = typeof value === 'string' && value ? text.indexOf(value) : -1;
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - 200, text.length - BUNDLE_EVIDENCE_CHARACTERS));
  return text.slice(start, start + BUNDLE_EVIDENCE_CHARACTERS);
}

function withShortEvidence(item, value) {
  return item && typeof item === 'object' && typeof item.evidence === 'string' ? { ...item, evidence: evidenceExcerpt(item.evidence, value) } : item;
}

function bundleFacts(facts) {
  return Array.isArray(facts) ? facts.map((fact) => withShortEvidence(fact, fact?.value)) : [];
}

function bundleProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  return {
    ...profile,
    ...(Array.isArray(profile.services) ? { services: profile.services.map((service) => withShortEvidence(service, service?.name)) } : {}),
    ...(profile.hours && typeof profile.hours === 'object' ? { hours: withShortEvidence(profile.hours, profile.hours.label) } : {}),
  };
}

function retrievalResult(knowledge, input, forcedGroups = null) {
  const revisionId = knowledge?.id;
  const owner = ownerFactPassages(knowledge, new Date().toISOString());
  const facts = [...(Array.isArray(knowledge?.groupedFacts) ? knowledge.groupedFacts : []), ...owner.facts];
  const passages = [...(Array.isArray(knowledge?.classifiedPassages) ? knowledge.classifiedPassages : []), ...owner.passages];
  const passageById = new Map(passages.map((passage) => [passage.passageId, passage]));
  const groups = new Set(forcedGroups ?? input.groups ?? []);
  const query = String(input.query ?? '').toLowerCase();
  if (!groups.size) {
    if (/\b(hours?|open|clos(?:e|ing)|weekend)\b/.test(query)) ['office_hours', 'service_hours', 'appointment_hours'].forEach((group) => groups.add(group));
    else if (/\b(price|cost|fee|quote)\b/.test(query)) groups.add('pricing_quote_policy');
    else if (/\b(cancel|reschedul|refund|policy)\b/.test(query)) groups.add('booking_cancellation_policy');
    else if (/\b(service|offer|provide|help with|do you do)\b/.test(query)) groups.add('services');
    else if (/\b(name|address|phone|email|contact|location|area)\b/.test(query)) { groups.add('identity_contact'); groups.add('locations_service_area'); }
  }
  const stop = new Set(['what', 'which', 'your', 'that', 'this', 'with', 'about', 'have', 'does', 'could', 'would', 'please', 'when', 'where', 'business', 'service', 'offer', 'provide']);
  const words = queryWords(query).filter((word) => !stop.has(word));
  const searchableOf = (fact) => `${JSON.stringify(fact.value)} ${fact.passageIds.map((id) => passageById.get(id)?.text ?? '').join(' ')}`.toLowerCase();
  // The call reads only the start of a long result, so the best matches come first. Without this an owner's own answer,
  // kept after every website fact, can be cut off. A word few facts contain ("process") counts for more than one most
  // facts contain ("cleaning"), so a specific answer outranks facts that only share common words.
  const ranked = (list) => {
    if (!words.length) return list;
    const texts = new Map(list.map((fact) => [fact, searchableOf(fact)]));
    const weight = new Map(words.map((word) => [word, 1 / Math.max(1, list.filter((fact) => texts.get(fact).includes(word)).length)]));
    const score = (fact) => words.reduce((sum, word) => sum + (texts.get(fact).includes(word) ? weight.get(word) : 0), 0);
    return list.map((fact) => [score(fact), fact]).sort((a, b) => b[0] - a[0]).map(([, fact]) => fact);
  };
  const selected = ranked(facts.filter((fact) => {
    if (fact?.eligibility !== 'eligible' || !Array.isArray(fact.passageIds) || !fact.passageIds.length || fact.passageIds.some((id) => !passageById.has(id))) return false;
    if (groups.size && !groups.has(fact.group)) return false;
    if (input.exactFactId && fact.factId !== input.exactFactId) return false;
    if (input.serviceId && !input.exactFactId && fact.factId !== input.serviceId && !fact.applicableServiceIds?.includes(input.serviceId)) return false;
    if (input.locationId && !fact.applicableLocationIds?.includes(input.locationId)) return false;
    if (groups.size || input.exactFactId || input.serviceId || input.locationId || !words.length) return true;
    const searchable = searchableOf(fact);
    return words.some((word) => searchable.includes(word));
  })).slice(0, 100);
  // Passages follow the order of the facts they support.
  const selectedPassages = [...new Set(selected.flatMap((fact) => fact.passageIds))].map((id) => passageById.get(id)).slice(0, 100);
  return validateRetrievalResult({ knowledgeRevisionId: revisionId, status: selected.length ? 'supported' : 'insufficient_information', facts: selected, passages: selectedPassages, ...(selected.length ? {} : { reason: 'No eligible sourced information supports this request.' }) });
}

function preparationAdmissionProblem(admission) {
  const limited = admission === 'rate_limited' || admission === 'inspection_busy';
  return problem(limited ? 429 : 503, limited ? admission : 'inspection_unavailable',
    admission === 'inspection_busy' ? 'A website check is already running. Try again shortly.' : 'Website preparation is temporarily unavailable.');
}

function preparationClientKey(request) {
  const peer = request.socket?.remoteAddress ?? '';
  const trustedPeers = String(process.env.FRONTLINE_TRUSTED_PROXY_IPS ?? '')
    .split(',').map((value) => value.trim()).filter((value) => isIP(value));
  if (!trustedPeers.includes(peer)) return peer || 'unknown';
  // Ingress must overwrite this header. Reject chains and malformed values.
  const forwarded = request.headers['x-frontline-client-ip'];
  if (typeof forwarded !== 'string' || !isIP(forwarded.trim())) {
    throw problem(503, 'inspection_unavailable', 'Website preparation is temporarily unavailable.');
  }
  return forwarded.trim();
}

function originGuard(request, allowMissing = false) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host) throw problem(403, 'origin_required', 'Host is required.');
  if (!origin && allowMissing) {
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw problem(403, 'origin_mismatch', 'Request must come from this application.');
    return;
  }
  if (!origin) throw problem(403, 'origin_required', 'Origin is required.');
  let parsed;
  try { parsed = new URL(origin); } catch { throw problem(403, 'invalid_origin', 'Origin is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') {
    throw problem(403, 'invalid_origin', 'Origin is invalid.');
  }
  const allowedOrigins = [process.env.APP_BASE_URL, ...String(process.env.FRONTLINE_ALLOWED_ORIGINS ?? '').split(',')]
    .map((value) => value?.trim()).filter(Boolean);
  if (allowedOrigins.length) {
    const matchesConfiguredOrigin = allowedOrigins.some((value) => {
      try { return parsed.origin === new URL(value).origin; } catch { return false; }
    });
    if (!matchesConfiguredOrigin) throw problem(403, 'origin_mismatch', 'Origin does not match this application.');
  } else if (parsed.host !== host || !['http:', 'https:'].includes(parsed.protocol)) {
    throw problem(403, 'origin_mismatch', 'Origin does not match this application.');
  }
}

function workspaceFrom(state, request) {
  const capability = cookies(request).fl_workspace;
  if (!capability || !/^[a-f0-9]{64}$/.test(capability)) throw problem(401, 'workspace_required', 'This workspace is unavailable.');
  const hash = tokenHash(capability);
  const workspace = Object.values(state.workspaces).find((item) => safeEqual(item.secretHash, hash));
  if (!workspace || workspace.state !== 'anonymous' || Date.parse(workspace.expiresAt) <= Date.now()) throw problem(401, 'workspace_expired', 'This workspace has expired.');
  return workspace;
}

function csrfGuard(request) {
  originGuard(request, request.method === 'GET');
  const csrf = cookies(request).fl_csrf;
  const header = request.headers['x-frontline-csrf'];
  if (!csrf || !safeEqual(csrf, header)) throw problem(403, 'csrf_failed', 'Refresh the page and try again.');
}

function authorizedPreparation(state, request, id) {
  const workspace = workspaceFrom(state, request);
  const record = state.preparations[id];
  if (!record || record.workspaceId !== workspace.id || Date.parse(record.expiresAt) <= Date.now()) throw problem(404, 'not_found', 'Preparation not found.');
  return record;
}

function authorizedDemo(state, request, id, allowClaimedOwner = false) {
  const demo = state.demos[id];
  let workspace;
  try { workspace = workspaceFrom(state, request); }
  catch (error) {
    if (!allowClaimedOwner || !demo || state.workspaces?.[demo.workspaceId]?.state !== 'claimed') throw error;
    workspace = state.workspaces[demo.workspaceId];
  }
  if (!demo || demo.workspaceId !== workspace.id || Date.parse(demo.expiresAt) <= Date.now()) throw problem(404, 'not_found', 'Demo not found.');
  return demo;
}

function internalAuth(request, demo) {
  const token = process.env.FRONTLINE_VOICE_SERVICE_TOKEN;
  if (!token || token.length < 32 || !safeEqual(`Bearer ${token}`, request.headers.authorization)) throw problem(401, 'service_unauthorized', 'Service identity required.');
  if (!safeEqual(demo.roomName, request.headers['x-frontline-room']) || Number(request.headers['x-frontline-generation']) !== demo.generation || !safeEqual(demo.agentVersionId ?? 'frontline-qa-v1', request.headers['x-frontline-agent-version-id'])) throw problem(403, 'demo_binding_mismatch', 'Demo binding mismatch.');
}

const capabilityIds = [
  ['Published services and hours', 'service_questions', 'Answer sourced service and hours questions'],
  ['Appointment requests', 'appointment_request', 'Collect an appointment request for later review'],
  ['Complaints', 'complaint_intake', 'Collect a concern for later review'],
  ['Human help', 'human_help', 'Explain the available public contact route'],
];

// Owner test calls and shared guest calls run against a pinned version of a claimed Bob, not a preparation.
const CLAIMED_CALL_MODES = new Set(['owner_test', 'shared_guest']);
const CLAIMED_CALL_POLICY = { owner_test: { callPurpose: 'owner_test', closingPolicy: 'test_summary' }, shared_guest: { callPurpose: 'shared_guest', closingPolicy: 'guest_feedback' } };

// The demo is bound by lineage: its agent version must be a revision of the demo's stable agent, and that
// revision's own knowledge and agent records must still be the ones the demo pinned. A later publish adds
// records and never rewrites these, so a running call keeps the version it started with.
function claimedRuntimeBinding(state, demo) {
  const revision = readLineage(state, demo.stableAgentId)?.revisions.find((item) => item.agentVersionId === demo.agentVersionId);
  const agent = state.agents?.[demo.agentVersionId];
  const knowledge = state.knowledge?.[demo.knowledgeRevisionId];
  if (!revision || revision.knowledgeRevisionId !== demo.knowledgeRevisionId || !agent || !knowledge
    || agent.workspaceId !== demo.workspaceId || knowledge.workspaceId !== demo.workspaceId || agent.knowledgeRevisionId !== knowledge.id) {
    throw problem(409, 'runtime_binding_mismatch', 'Pinned agent version is unavailable.');
  }
  // Matches what task start actually enforces (disabledWorkflowIds): a version with no capability list, or an
  // empty one, keeps every workflow on. Reading only `enabled === true` entries reported zero workflows for
  // that case, telling the worker to hide every task kind while the backend would have allowed all of them.
  const disabled = disabledWorkflowIds(state, demo);
  const enabledWorkflows = ALL_WORKFLOW_IDS.filter((workflowId) => !disabled.has(workflowId));
  // The name is pinned on the call when it starts, so a rename mid-call (or a worker reconnect) changes nothing for it.
  const receptionistName = demo.receptionistName ?? receptionistNameOf(readLineage(state, demo.stableAgentId));
  return { agent, knowledge, businessName: businessNameFor(state, demo.stableAgentId), profile: knowledge.groupedProfile ?? null, enabledWorkflows, receptionistName };
}

// The business type onboarding labelled (for example "plumbing contractor"), so the call can ask the questions that
// trade asks. A claimed call reads it from the preparation of the same workspace, since claiming keeps that record.
function businessTypeFor(state, demo) {
  const preparations = Object.values(state.preparations ?? {});
  const preparation = state.preparations?.[demo.preparationId]
    ?? preparations.find((item) => item.workspaceId === demo.workspaceId && item.businessFit);
  const type = preparation?.businessFit?.businessType;
  return typeof type === 'string' && type.trim() ? type.trim().slice(0, 80) : null;
}

function claimedSetupResponse(state, kind, id) {
  // A claimed scope holds one workspace and, with several receptionists, several agents. An agent answers for the
  // workspace it belongs to, never for whichever claimed workspace comes first.
  const workspace = kind === 'agent' ? state.workspaces?.[state.agents?.[id]?.workspaceId] : state.workspaces?.[id];
  if (workspace?.state !== 'claimed') return null;
  if (kind === 'workspace') {
    const draft = state.workspaceDrafts?.[id] ?? { version: 1, state: 'draft', missingContext: '' };
    return { workspaceId: id, claimState: 'claimed', version: draft.version, setupVersion: draft.version, setup: { state: draft.state, missingContext: draft.missingContext }, activation: { status: 'unavailable', providerConfirmed: false } };
  }
  const agent = state.agents?.[id];
  if (!agent || agent.workspaceId !== workspace.id) return null;
  const preparation = Object.values(state.preparations ?? {}).find((item) => item.agentVersionId === id);
  const topics = new Set((agent.capabilityManifest?.capabilities ?? []).map((item) => item.topic));
  const supportedCapabilities = capabilityIds.filter(([topic]) => topics.has(topic)).map(([, capabilityId, label]) => ({ id: capabilityId, label, description: 'Setup draft only; no live action is enabled.' }));
  const recommendedUseCase = supportedCapabilities.find((item) => item.id === 'appointment_request') ?? supportedCapabilities[0] ?? null;
  const draft = state.setups?.[id] ?? { version: 1, state: 'draft', selectedCapabilityIds: recommendedUseCase ? [recommendedUseCase.id] : [], missingContext: '' };
  return { agentId: id, workspaceId: workspace.id, claimState: 'claimed', version: draft.version, setupVersion: draft.version,
    businessName: preparation?.profile?.businessName ?? businessNameFor(state, id), sourceAgentVersionId: id,
    knowledgeRevisionId: agent.knowledgeRevisionId,
    setup: { state: draft.state, selectedCapabilityIds: draft.selectedCapabilityIds, missingContext: draft.missingContext,
      supportedCapabilities, recommendedUseCase: recommendedUseCase ? { id: recommendedUseCase.id, label: recommendedUseCase.label, reason: 'Based on the prepared demo capability manifest; review before live use.' } : null },
    activation: { status: 'unavailable', providerConfirmed: false } };
}

export function createApiHandler(options = {}) {
  const store = options.store ?? (process.env.DATABASE_URL ? new PostgresStore() : new DevelopmentStore());
  const prepare = options.prepareBusiness ?? prepareBusinessFromWebsite;
  const exaRequired = !options.prepareBusiness;
  const exaDailyLimit = Number(process.env.FRONTLINE_EXA_DAILY_MAX_PREPARATIONS);
  const exaConfigured = () => researchConfiguration().ready;
  const preparationQueue = options.preparationQueue ?? createPreparationQueue({ store, prepare, paidResearch: exaRequired ? { dailyLimit: exaDailyLimit } : null });
  const voice = options.voiceAdapter;
  // A voice adapter cannot enable paid starts without an enforcing reservation gate.
  const paidStartGate = options.paidStartGate ?? createPaidStartGate(store);
  const authClaims = options.authClaims ?? (store instanceof PostgresStore ? createAuthClaims({ pool: store.pool }) : null);
  const jev = options.jevClassifier ?? createJevClassifier();
  const classifyTurn = options.classifyTurn ?? ((text, context) => jev.classify(text, context));

  // A shared guest call consumes its link in the same transaction that ends the call. Other demos are unaffected.
  const consumeShareOnTerminal = (demo) => (store instanceof PostgresStore && demo.shareGrantId
    ? { beforeCommit: (client, state) => store.settleClaimedCall(client, state.demos[demo.id], false) }
    : undefined);

  // Ends a call because its share link was revoked or expired, through the same forced terminal state
  // and cleanup the hard-end watchdog uses. There is no dedicated terminal reason for a link, so the
  // call records the platform-ended reason and the link keeps its own terminal reason.
  async function endClaimedDemo({ scopeId, demoId, terminalReason = 'hard_end_elapsed' }) {
    if (!(store instanceof PostgresStore)) return;
    const ended = await store.endClaimedDemo({ ownerScopeId: scopeId, demoId, reason: terminalReason });
    if (!ended) return;
    await recordOwnerTestCompleted(ended);
    const terminalDemo = { ...ended, deadlinePhase: ended.startedAt ? 'active' : 'setup', hardEndAt: ended.hardEndAt ?? ended.setupDeadlineAt };
    if (await endVoiceBounded(voice, terminalDemo)) { try { await finalizeVoiceCleanup(store, paidStartGate, terminalDemo); } catch { /* Durable deadline cleanup retries independently. */ } } else retryVoiceCleanupSoon(voice, store, paidStartGate, terminalDemo);
  }

  // An owner test that ended counts as tested when the owner spoke. Best effort, safe to repeat.
  async function recordOwnerTestCompleted(demo) {
    if (demo?.mode !== 'owner_test' || !poDb) return;
    try { await markOwnerTestCompleted({ db: poDb, scopeId: demo.workspaceId, stableAgentId: demo.stableAgentId, demoId: demo.id }); } catch { /* The owner's own end request records it too. */ }
  }

  // The owner or the guest ends their own call. A call the worker is already closing is left to the worker.
  const endClaimedByCaller = (mode) => async ({ scopeId, demoId }) => {
    const demo = await readDemo(poDb, scopeId, demoId);
    if (!demo || demo.mode !== mode) throw problem(404, 'not_found', 'Not found.');
    if (demo.state === 'ending') return { demoId, state: 'ending' };
    if (!['ended', 'failed'].includes(demo.state)) await endClaimedDemo({ scopeId, demoId, terminalReason: 'caller_ended' });
    return { demoId, state: 'ended' };
  };

  async function sweepShareLinks() {
    if (!(store instanceof PostgresStore)) return { expired: 0 };
    await store.ensureReady();
    return expireDueShares({ db: fromPool(store.pool), endLiveCall: endClaimedDemo });
  }

  // The post-onboarding routes (owner, guest, builder and worker). They need Postgres. Paid starts keep the
  // same gates as anonymous demos: a configured adapter, a healthy durable watchdog and an enforcing gate.
  const poDb = store instanceof PostgresStore ? fromPool(store.pool) : null;
  const poOptions = options.postOnboarding ?? {};
  const claimedVoice = voice && {
    isConfigured: () => options.enablePaidVoiceStarts === true && Boolean(voice.isConfigured?.() && voice.watchdogHealthy?.() && paidStartGate?.claimedLimits?.()),
    start: (demo, reservation) => voice.start(demo, reservation),
    end: (demo) => voice.end(demo),
    issueParticipantToken: (demo) => voice.issueParticipantToken(demo),
  };
  const handlePostOnboarding = poDb ? createPostOnboardingHandler({
    enabled: postOnboardingEnabled,
    db: poDb,
    owner: createOwnerResolver({ db: poDb }),
    appBaseUrl: poOptions.appBaseUrl ?? process.env.APP_BASE_URL ?? '',
    voice: claimedVoice,
    get guestConfig() { return { ...DEFAULT_GUEST_CONFIG, ...(paidStartGate?.claimedLimits?.() ?? {}), callArchitectureVersion: process.env.FRONTLINE_CALL_ARCHITECTURE === 'bob-task-v1' ? 'bob-task-v1' : 'legacy-v1' }; },
    endLiveCall: endClaimedDemo,
    endGuestDemo: endClaimedByCaller('shared_guest'),
    endOwnerDemo: endClaimedByCaller('owner_test'),
    // The worker's own service credential, checked against the demo's room, generation and agent version.
    worker: async (request, demoId) => {
      const state = await store.read();
      const demo = state.demos?.[demoId];
      if (!demo || Date.parse(demo.expiresAt) <= Date.now() || isCallFenced(state, demo)) return null;
      internalAuth(request, demo);
      return { scopeId: demo.workspaceId };
    },
    secureCookie: secureCookieSuffix() !== '',
    extraction: poOptions.extraction,
    writeRecap: 'writeRecap' in poOptions ? poOptions.writeRecap : createRecapWriter(),
    limits: poOptions.limits,
    newId: poOptions.newId,
    now: poOptions.now,
  }) : null;

  const handle = async (request, response, url) => {
    const requestId = randomUUID();
    try {
      if (process.env.NODE_ENV === 'production' && store instanceof DevelopmentStore) throw problem(503, 'storage_unavailable', 'Production storage is not configured.');
      if (url.pathname === '/v1/session' && request.method === 'GET') {
        originGuard(request, true);
        const existing = cookies(request).fl_csrf;
        const csrf = existing && /^[a-f0-9]{64}$/.test(existing) ? existing : randomBytes(32).toString('hex');
        const secure = secureCookieSuffix();
        respond(response, 200, { csrfToken: csrf }, requestId, { 'set-cookie': `fl_csrf=${csrf}; Path=/; SameSite=Strict${secure}` });
        return;
      }

      if (url.pathname === '/v1/preparations' && request.method === 'POST') {
        csrfGuard(request);
        if (exaRequired && !exaConfigured()) throw problem(503, 'research_unavailable', 'Business research is not configured yet.');
        const body = requireObject(await jsonBody(request), ['url']);
        const canonicalUrl = validateInspectionUrl(body.url).toString();
        const now = Date.now();
        const id = randomUUID();
        const expiresAt = iso(now + TTL_MS);
        const existingToken = cookies(request).fl_workspace;
        const clientKey = preparationClientKey(request);
        let issuedToken;
        const record = await store.transaction((state) => {
          let workspace;
          if (existingToken && /^[a-f0-9]{64}$/.test(existingToken)) workspace = Object.values(state.workspaces).find((item) => item.secretHash === tokenHash(existingToken) && item.state === 'anonymous' && Date.parse(item.expiresAt) > now);
          if (!workspace) {
            issuedToken = randomBytes(32).toString('hex');
            workspace = { id: randomUUID(), secretHash: tokenHash(issuedToken), state: 'anonymous', expiresAt };
            state.workspaces[workspace.id] = workspace;
          }
          const next = { id, workspaceId: workspace.id, url: canonicalUrl, state: 'researching', revision: 1, createdAt: iso(now), expiresAt: workspace.expiresAt, profile: null, gaps: [] };
          state.preparations[id] = next;
          return next;
        }, store instanceof PostgresStore ? {
          beforeCommit: async (client, _state, next) => {
            let admission;
            try { admission = await preparationQueue.enqueueInTransaction?.(client, { id, workspaceId: next.workspaceId, clientKey }); }
            catch { admission = 'inspection_unavailable'; }
            if (admission !== 'admitted') throw preparationAdmissionProblem(admission);
          },
        } : undefined);
        if (!(store instanceof PostgresStore)) {
          let admission;
          try { admission = await preparationQueue.enqueue({ id, workspaceId: record.workspaceId, clientKey, url: canonicalUrl }); }
          catch { admission = 'inspection_unavailable'; }
          if (admission !== 'admitted') {
            await store.transaction((state) => {
              delete state.preparations[id];
              if (issuedToken) delete state.workspaces[record.workspaceId];
            });
            throw preparationAdmissionProblem(admission);
          }
        }
        const cookie = issuedToken ? { 'set-cookie': `fl_workspace=${issuedToken}; HttpOnly; Path=/; SameSite=Strict${secureCookieSuffix()}` } : {};
        respond(response, 202, { preparationId: id, state: 'researching', expiresAt: record.expiresAt }, requestId, cookie);
        return;
      }

      const prepMatch = url.pathname.match(/^\/v1\/preparations\/([0-9a-f-]{36})$/);
      if (prepMatch && request.method === 'GET') {
        csrfGuard(request);
        const record = authorizedPreparation(await store.read(), request, prepMatch[1]);
        respond(response, 200, publicPreparation(record), requestId);
        return;
      }

      const previewMatch = url.pathname.match(/^\/v1\/agent-versions\/([0-9a-f-]{36})\/preview$/);
      if (previewMatch && request.method === 'GET') {
        csrfGuard(request);
        const state = await store.read();
        const workspace = workspaceFrom(state, request);
        const agent = state.agents[previewMatch[1]];
        if (!agent || agent.workspaceId !== workspace.id) throw problem(404, 'not_found', 'Agent version not found.');
        const preparation = Object.values(state.preparations).find((item) => item.agentVersionId === agent.id);
        respond(response, 200, { agentVersionId: agent.id, knowledgeRevisionId: agent.knowledgeRevisionId, mode: 'business_demo', profile: preparation?.profile ?? null, capabilityManifest: agent.capabilityManifest, gaps: preparation?.gaps ?? [], expiresAt: agent.expiresAt }, requestId);
        return;
      }

      if (url.pathname === '/v1/demos' && request.method === 'POST') {
        csrfGuard(request);
        const body = requireObject(await jsonBody(request), ['preparationId', 'expectedRevision', 'mode']);
        if (!/^[0-9a-f-]{36}$/.test(body.preparationId ?? '') || !Number.isInteger(body.expectedRevision) || !['business_demo', 'frontline_qa'].includes(body.mode)) throw problem(400, 'invalid_demo_request', 'Choose an available mode and current preparation revision.');
        const state = await store.read();
        const preparation = authorizedPreparation(state, request, body.preparationId);
        if (preparation.revision !== body.expectedRevision) throw problem(409, 'stale_preparation', 'Preparation changed. Refresh before starting.');
        if (body.mode === 'business_demo' && !['ready', 'limited_ready'].includes(preparation.state)) throw problem(409, 'business_demo_unavailable', 'Business context is not ready for a demo.');
        if (body.mode === 'frontline_qa' && preparation.state !== 'insufficient_context') throw problem(409, 'frontline_qa_unavailable', 'Frontline Q&A is available when business context is insufficient.');
        if (body.mode === 'business_demo') {
          const knowledge = state.knowledge[preparation.knowledgeRevisionId];
          const agent = state.agents[preparation.agentVersionId];
          if (!knowledge || !agent || knowledge.workspaceId !== preparation.workspaceId || agent.workspaceId !== preparation.workspaceId || agent.knowledgeRevisionId !== knowledge.id) throw problem(409, 'business_demo_unavailable', 'Business context is not ready for a demo.');
        }
        if (options.enablePaidVoiceStarts !== true || !(store instanceof PostgresStore) || !voice?.isConfigured?.() || !voice?.watchdogHealthy?.() || typeof paidStartGate?.reserve !== 'function' || !process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
          console.error(JSON.stringify({ event: 'voice_start_rejected', stage: 'configuration', requestId }));
          throw problem(503, 'voice_unavailable', 'Voice is not available yet.');
        }
        const reservation = await paidStartGate.reserve({ workspaceId: preparation.workspaceId, preparationId: preparation.id, mode: body.mode });
        if (!reservation?.id || reservation.approved !== true) {
          console.error(JSON.stringify({ event: 'voice_start_rejected', stage: 'reservation', reason: reservation?.reason ?? 'unavailable', requestId }));
          if (reservation?.reason === 'voice_limit_reached') throw problem(429, 'voice_limit_reached', 'Calls are paused right now. Please contact the Frontline team.');
          throw problem(503, 'voice_unavailable', 'Voice is not available yet.');
        }
        // Voice adapter must mint a room-scoped browser token and dispatch the named worker.
        const id = randomUUID();
        const createdAt = Date.now();
        const callArchitectureVersion = process.env.FRONTLINE_CALL_ARCHITECTURE === 'bob-task-v1' ? 'bob-task-v1' : 'legacy-v1';
        const demo = { id, workspaceId: preparation.workspaceId, preparationId: preparation.id, preparationRevision: preparation.revision, mode: body.mode, callArchitectureVersion, agentVersionId: body.mode === 'business_demo' ? preparation.agentVersionId : null, knowledgeRevisionId: body.mode === 'business_demo' ? preparation.knowledgeRevisionId : 'frontline-product-v1', roomName: `frontline-demo-${id}`, generation: 1, reservationId: reservation.id, state: 'dispatching', stateRevision: 1, reconnectAllowed: true, terminalReason: null, createdAt: iso(createdAt), setupDeadlineAt: iso(createdAt + 20_000), expiresAt: preparation.expiresAt, startedAt: null, softCloseAt: null, hardEndAt: null };
        let attemptedDispatch = false;
        try {
          await store.transaction((mutable) => { mutable.demos[id] = demo; });
          attemptedDispatch = true;
          const connection = await voice.start(demo, reservation);
          if (connection.roomName !== demo.roomName || connection.participantIdentity !== `visitor-${id}` || typeof connection.participantToken !== 'string' || typeof connection.livekitUrl !== 'string' || !Number.isFinite(Date.parse(connection.tokenExpiresAt)) || Date.parse(connection.tokenExpiresAt) > Date.now() + 7 * 60_000) throw new Error('LiveKit dispatch response is incomplete.');
          await store.transaction((mutable) => {
            const current = mutable.demos[id];
            if (current.state !== 'dispatching' || Date.parse(current.setupDeadlineAt) <= Date.now() + 5_000) throw new Error('Setup deadline elapsed before dispatch completed.');
            current.state = 'waiting';
            current.roomName = connection.roomName ?? current.roomName;
            current.dispatchId = connection.dispatchId ?? null;
            current.participantIdentity = connection.participantIdentity ?? null;
          });
          respond(response, 201, { demoId: id, mode: demo.mode, livekitUrl: connection.livekitUrl, participantToken: connection.participantToken, tokenExpiresAt: connection.tokenExpiresAt, setupDeadlineAt: demo.setupDeadlineAt, expiresAt: demo.expiresAt }, requestId);
        } catch (error) {
          console.error(JSON.stringify({ event: 'voice_start_rejected', stage: 'dispatch', errorName: error?.name ?? 'Error', errorCode: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null, requestId }));
          let roomDeleted = !attemptedDispatch;
          if (attemptedDispatch) {
            try { await voice.end(demo); roomDeleted = true; } catch { /* Keep the budget reservation until room cleanup/reconciliation. */ }
          }
          if (roomDeleted) {
            try { await store.transaction((mutable) => { if (mutable.demos[id]) { mutable.demos[id].state = 'failed'; mutable.demos[id].voiceCleanupCompleted = true; } }); } catch { /* Caller still receives a failure. */ }
            if (typeof paidStartGate.release === 'function') {
              try { await paidStartGate.release(reservation.id); } catch { /* Reservation TTL is the final cleanup fallback. */ }
            }
          }
          throw problem(503, 'voice_unavailable', 'Voice is not available yet.');
        }
        return;
      }

      const demoMatch = url.pathname.match(/^\/v1\/demos\/([0-9a-f-]{36})(?:\/(end|result))?$/);
      if (demoMatch) {
        csrfGuard(request);
        const state = await store.read();
        const demo = authorizedDemo(state, request, demoMatch[1], demoMatch[2] === 'result' && request.method === 'GET' && store instanceof PostgresStore);
        if ((!demoMatch[2] || demoMatch[2] === 'result') && request.method === 'GET') {
          const captured = state.requests[demo.id] ?? null;
          const base = { demoId: demo.id, state: demo.state, mode: demo.mode, setupDeadlineAt: demo.setupDeadlineAt, startedAt: demo.startedAt, softCloseAt: demo.softCloseAt, hardEndAt: demo.hardEndAt, appointmentRequest: captured, terminalReason: demo.terminalReason ?? null, reconnectAllowed: demo.reconnectAllowed ?? !['ending', 'terminal', 'ended'].includes(demo.state), stateRevision: demo.stateRevision ?? 1, expiresAt: demo.expiresAt };
          respond(response, 200, demoMatch[2] === 'result' ? { ...base, requests: withNextSteps(state.outcomes?.[demo.id]), cases: withNextSteps(state.cases?.[demo.id]), lookups: Object.values(state.lookups ?? {}).filter((item) => item.outcome?.demoId === demo.id).map((item) => item.outcome), receipts: Object.values(state.receipts ?? {}).filter((item) => item.workflowInstanceId === state.workflows?.[demo.id]?.workflowInstanceId), callSummary: buildCallSummary(state, demo) } : base, requestId);
          return;
        }
        if (demoMatch[2] === 'end' && request.method === 'POST') {
          const endResult = await store.transaction((mutable) => {
            const current = mutable.demos[demo.id];
            if (current.state === 'ended' && current.terminalResponse) return current.terminalResponse;
            if (current.state === 'active') {
              const ending = beginEnding(mutable, current, { expectedStateRevision: current.stateRevision ?? 1, reason: 'caller_ended' });
              return finishTerminal(mutable, current, { expectedStateRevision: ending.stateRevision, reason: 'caller_ended' });
            }
            // An authoritative /turn escalation owns its bounded close. The
            // browser may observe/end its local connection, but must not race
            // the worker's required persistence or closing speech. Only the
            // authenticated worker /terminal route (or the hard-deadline
            // watchdog) may advance this already-ending session.
            if (current.state === 'ending') return current.endingResponse;
            return forceTerminal(mutable, current, 'caller_ended');
          }, consumeShareOnTerminal(demo));
          const terminal = endResult.status === 'terminal';
          if (terminal) {
            const terminalDemo = { ...demo, state: 'ended', terminalReason: endResult.reason };
            if (await endVoiceBounded(voice, terminalDemo)) { try { await finalizeVoiceCleanup(store, paidStartGate, terminalDemo); } catch { /* Durable deadline cleanup retries independently. */ } } else retryVoiceCleanupSoon(voice, store, paidStartGate, terminalDemo);
          }
          respond(response, 200, { demoId: demo.id, state: terminal ? 'ended' : 'ending', terminalReason: endResult.reason, reconnectAllowed: endResult.reconnectAllowed, stateRevision: endResult.stateRevision, expiresAt: demo.expiresAt }, requestId);
          return;
        }
      }

      const historyMatch = url.pathname.match(/^\/v1\/(agents|workspaces)\/([0-9a-f-]{36})\/history$/);
      if (historyMatch && request.method === 'GET') {
        csrfGuard(request);
        if (!authClaims?.isConfigured() || !(store instanceof PostgresStore)) throw problem(503, 'history_unavailable', 'History is not available yet.');
        const kind = historyMatch[1] === 'agents' ? 'agent' : 'workspace'; const resourceId = historyMatch[2];
        const member = await authClaims.resolveMemberScope({ authCookie: cookies(request).fl_auth, workspaceId: kind === 'workspace' ? resourceId : (await store.read()).agents?.[resourceId]?.workspaceId });
        if (!member) throw problem(404, 'not_found', 'Saved resource not found.');
        const state = await store.read(); const demos = Object.values(state.demos).filter((item) => item.workspaceId === member && (kind === 'workspace' || item.agentVersionId === resourceId || item.stableAgentId === resourceId)); const ids = new Set(demos.map((item) => item.id));
        respond(response, 200, { resourceKind: kind, resourceId, requests: withNextSteps(Object.entries(state.outcomes ?? {}).filter(([id]) => ids.has(id)).flatMap(([, rows]) => rows)), cases: withNextSteps(Object.entries(state.cases ?? {}).filter(([id]) => ids.has(id)).flatMap(([, rows]) => rows)), lookups: Object.values(state.lookups ?? {}).map((item) => item.outcome).filter((item) => ids.has(item?.demoId)), receipts: Object.values(state.receipts ?? {}).filter((item) => demos.some((demo) => state.workflows?.[demo.id]?.workflowInstanceId === item.workflowInstanceId)), callSummaries: demos.filter((demo) => ['ended', 'failed'].includes(demo.state)).slice(-50).map((demo) => buildCallSummary(state, demo)).filter((summary) => summary.callerTurnCount || summary.tasks.length), nextCursor: null }, requestId);
        return;
      }

      if (url.pathname === '/v1/claim-intents' && request.method === 'GET') {
        csrfGuard(request);
        if (!authClaims?.isConfigured()) throw problem(503, 'identity_unavailable', 'Saving is not available yet.');
        const demoId = url.searchParams.get('demoId');
        if (!/^[0-9a-f-]{36}$/.test(demoId ?? '')) throw problem(400, 'invalid_demo_id', 'Choose a completed demo.');
        const state = await store.read();
        const demo = authorizedDemo(state, request, demoId);
        if (demo.state !== 'ended') throw problem(409, 'demo_not_complete', 'Finish the demo before saving it.');
        const kind = demo.mode === 'business_demo' ? 'agent' : 'workspace';
        const targetId = kind === 'agent' ? demo.agentVersionId : demo.workspaceId;
        if (!targetId) throw problem(409, 'claim_unavailable', 'The prepared resource is unavailable.');
        try {
          const grant = await authClaims.issueGrant({ workspaceCookie: cookies(request).fl_workspace, demoId: demo.id, targetKind: kind, targetId });
          respond(response, 200, { claimIntentId: demo.id, claimable: true, kind, expiresAt: grant.expiresAt }, requestId, { 'set-cookie': grant.setCookie });
        } catch { throw problem(409, 'claim_unavailable', 'This demo cannot be saved.'); }
        return;
      }

      if (url.pathname === '/v1/auth/google/start' && request.method === 'POST') {
        csrfGuard(request);
        if (!authClaims?.googleConfigured()) throw problem(503, 'identity_unavailable', 'Google sign-in is not configured yet.');
        const body = requireObject(await jsonBody(request), ['claimIntentId', 'consent']);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.claimIntentId ?? '') || body.consent !== true
          || !/^[a-f0-9]{64}$/.test(cookies(request).fl_claim ?? '')) throw problem(400, 'claim_unavailable', 'Choose a completed demo before signing in.');
        const flow = authClaims.startGoogle();
        respond(response, 200, { authorizationUrl: flow.authorizationUrl }, requestId, { 'set-cookie': flow.setCookies });
        return;
      }

      if (url.pathname === '/v1/auth/google/signin' && request.method === 'POST') {
        // A plain sign-in with no claimed resource in hand yet: the landing page's "Sign in" link, for a
        // returning owner who wants their saved Bob without a claim intent or a known resource id. The owner
        // screens look up everything tied to the verified account afterward (GET /v1/me/agents).
        csrfGuard(request);
        if (!authClaims?.googleConfigured()) throw problem(503, 'identity_unavailable', 'Google sign-in is not configured yet.');
        const flow = authClaims.startGoogle();
        respond(response, 200, { authorizationUrl: flow.authorizationUrl }, requestId, { 'set-cookie': flow.setCookies });
        return;
      }

      if (url.pathname === '/v1/auth/google/reauth' && request.method === 'POST') {
        csrfGuard(request);
        if (!authClaims?.googleConfigured()) throw problem(503, 'identity_unavailable', 'Google sign-in is not configured yet.');
        const body = requireObject(await jsonBody(request), ['resourceKind', 'resourceId']);
        if (!['agent', 'workspace'].includes(body.resourceKind)
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.resourceId ?? '')) throw problem(400, 'invalid_resource', 'Choose a saved resource.');
        const flow = authClaims.startGoogle();
        respond(response, 200, { authorizationUrl: flow.authorizationUrl }, requestId, { 'set-cookie': flow.setCookies });
        return;
      }

      if (url.pathname === '/v1/auth/google/callback' && request.method === 'GET') {
        const browserCookies = cookies(request);
        let succeeded = false;
        let setCookies = authClaims?.clearGoogleFlow?.() ?? [];
        try {
          if (!authClaims?.googleConfigured() || url.searchParams.has('error')) throw new Error('Google sign-in incomplete');
          const result = await authClaims.completeGoogle({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), browserCookies,
            previousAuthCookie: browserCookies.fl_auth });
          setCookies = result.setCookies;
          succeeded = true;
        } catch (error) {
          // Return to the claim screen without leaking provider details in the redirect, but keep enough
          // in the server log (name/code only, matching the voice-start rejection logging above) to tell
          // a token-exchange failure apart from a database error without exposing tokens or PII.
          console.error(JSON.stringify({ event: 'google_signin_failed', errorName: error?.name ?? 'Error', errorCode: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null, requestId }));
        }
        response.writeHead(303, { location: `/?auth=${succeeded ? 'google-complete' : 'google-error'}`, 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'set-cookie': setCookies });
        response.end();
        return;
      }

      if (url.pathname === '/v1/claims' && request.method === 'POST') {
        csrfGuard(request);
        if (!authClaims?.isConfigured()) throw problem(503, 'identity_unavailable', 'Saving is not available yet.');
        const body = requireObject(await jsonBody(request), ['claimIntentId']);
        if (!/^[0-9a-f-]{36}$/.test(body.claimIntentId ?? '')) throw problem(400, 'invalid_claim_intent', 'Choose a completed demo.');
        try {
          const claimed = await authClaims.claim({ workspaceCookie: cookies(request).fl_workspace, grantCookie: cookies(request).fl_claim, authCookie: cookies(request).fl_auth, demoId: body.claimIntentId });
          respond(response, 201, { state: 'claimed', kind: claimed.ownership.kind, ...(claimed.ownership.kind === 'agent' ? { agentId: claimed.ownership.id } : { workspaceId: claimed.ownership.id }), tenantId: claimed.tenantId }, requestId, { 'set-cookie': [...claimed.clearCookies, ownerTargetCookie(claimed.ownership.kind, claimed.ownership.id)] });
        } catch { throw problem(409, 'claim_unavailable', 'This demo could not be saved. Sign in with the same account or start again.'); }
        return;
      }

      if (url.pathname === '/v1/auth/logout' && request.method === 'POST') {
        csrfGuard(request);
        if (!authClaims) throw problem(503, 'identity_unavailable', 'Sign-out is unavailable.');
        const result = await authClaims.logout({ authCookie: cookies(request).fl_auth });
        respond(response, 200, { state: 'signed_out' }, requestId, { 'set-cookie': [result.clearCookie, ...(result.clearProfileCookies ?? [result.clearNameCookie]), ownerTargetCookie('workspace', '00000000-0000-0000-0000-000000000000', true)].filter(Boolean) });
        return;
      }

      const setupMatch = url.pathname.match(/^\/v1\/(agents|workspaces)\/([0-9a-f-]{36})(?:\/(setup|context))?$/);
      // Only the setup read and save are answered here. DELETE /v1/agents/:id belongs to the post-onboarding routes below.
      if (setupMatch && ['GET', 'PATCH'].includes(request.method)) {
        csrfGuard(request);
        if (!authClaims?.isConfigured() || !(store instanceof PostgresStore)) throw problem(503, 'setup_unavailable', 'Account setup is not available yet.');
        const kind = setupMatch[1] === 'agents' ? 'agent' : 'workspace';
        const targetId = setupMatch[2];
        if (!setupMatch[3] && request.method === 'GET') {
          const result = claimedSetupResponse(await store.read(), kind, targetId);
          if (!result) throw problem(404, 'not_found', 'Saved resource not found.');
          respond(response, 200, result, requestId);
          return;
        }
        if (request.method === 'PATCH' && ((kind === 'agent' && setupMatch[3] === 'setup') || (kind === 'workspace' && setupMatch[3] === 'context'))) {
          const body = requireObject(await jsonBody(request), kind === 'agent' ? ['expectedVersion', 'selectedCapabilityIds', 'missingContext'] : ['expectedVersion', 'missingContext']);
          if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || typeof body.missingContext !== 'string') throw problem(400, 'invalid_setup', 'Review the setup fields and try again.');
          if (body.missingContext.length > 8000) throw problem(400, 'invalid_setup', `The business details are ${body.missingContext.length.toLocaleString('en-US')} characters. Shorten them to 8,000 or fewer and save again.`);
          if (kind === 'agent' && (!Array.isArray(body.selectedCapabilityIds) || body.selectedCapabilityIds.length > 8 || body.selectedCapabilityIds.some((item) => typeof item !== 'string') || new Set(body.selectedCapabilityIds).size !== body.selectedCapabilityIds.length)) throw problem(400, 'invalid_setup', 'Choose supported capabilities only.');
          const result = await store.transaction((state) => {
            const current = claimedSetupResponse(state, kind, targetId);
            if (!current) throw problem(404, 'not_found', 'Saved resource not found.');
            if (current.version !== body.expectedVersion) throw problem(409, 'stale_setup', 'Setup changed. Refresh before saving.');
            if (kind === 'agent') {
              const allowed = new Set(current.setup.supportedCapabilities.map((item) => item.id));
              if (body.selectedCapabilityIds.some((item) => !allowed.has(item))) throw problem(400, 'invalid_setup', 'Choose supported capabilities only.');
              state.setups ??= {};
              state.setups[targetId] = { version: current.version + 1, state: 'saved', selectedCapabilityIds: body.selectedCapabilityIds, missingContext: body.missingContext.trim(), updatedAt: iso(Date.now()) };
            } else {
              state.workspaceDrafts ??= {};
              state.workspaceDrafts[targetId] = { version: current.version + 1, state: 'saved', missingContext: body.missingContext.trim(), updatedAt: iso(Date.now()) };
            }
            return claimedSetupResponse(state, kind, targetId);
          });
          respond(response, 200, result, requestId);
          return;
        }
      }

      const internalMatch = url.pathname.match(/^\/v1\/internal\/demos\/([0-9a-f-]{36})\/(runtime|lookup-business-fact|lookup-frontline-fact|update-simulated-request|ready|caller-turns|turn|task|task-end|requests\/validate|requests\/readback|requests\/confirmations|requests|appointments\/lookup|cases|escalations|ending|terminal|services|services\/details)$/);
      if (internalMatch) {
        const state = await store.read();
        const demo = state.demos[internalMatch[1]];
        const action = internalMatch[2];
        if (!demo || Date.parse(demo.expiresAt) <= Date.now() || demo.state === 'failed' || (demo.state === 'ended' && !['terminal', 'turn', 'caller-turns', 'task', 'task-end', 'escalations'].includes(action))) throw problem(404, 'not_found', 'Demo not found.');
        internalAuth(request, demo);
        // A call pinned to a version that a privacy erasure has fenced gets nothing from the runtime, except to finish.
        if (action !== 'terminal' && isCallFenced(state, demo)) throw problem(404, 'not_found', 'Demo not found.');
        const businessOnlyActions = new Set(['lookup-business-fact', 'requests/validate', 'requests/readback', 'requests/confirmations', 'requests', 'appointments/lookup', 'cases', 'escalations', 'services', 'services/details', 'update-simulated-request']);
        if (demo.mode === 'frontline_qa' && businessOnlyActions.has(action)) throw problem(403, 'wrong_mode', 'Business tools are unavailable in Frontline Q&A mode.');
        // Voice agent v2 removed the bob-task-v1 readback, so requests/readback is legacy-only too.
        const legacyOnlyActions = new Set(['turn', 'requests/validate', 'requests/readback', 'requests/confirmations', 'requests', 'appointments/lookup', 'cases', 'update-simulated-request']);
        if (demo.callArchitectureVersion === 'bob-task-v1' && legacyOnlyActions.has(action)) throw problem(409, 'unsupported_call_architecture', 'Use the task protocol for this call.');
        if (action === 'caller-turns' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => recordTurn(mutable, mutable.demos[demo.id], body, classifyTurn, false)); respond(response, 201, result, requestId); return; }
        if (action === 'turn' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => recordTurn(mutable, mutable.demos[demo.id], body, classifyTurn, true)); respond(response, 200, result, requestId); return; }
        if (action === 'task' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => validateContract('task.schema.json#/$defs/response', taskCommand(mutable, mutable.demos[demo.id], body, { lookupFailureReason: options.lookupFailureReason }))); respond(response, 200, result, requestId); return; }
        if (action === 'task-end' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => taskEnd(mutable, mutable.demos[demo.id], body)); respond(response, 200, result, requestId); return; }
        if (action === 'requests/validate' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => validateFields(mutable, mutable.demos[demo.id], body)); respond(response, 200, result, requestId); return; }
        if (action === 'requests/readback' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => recordReadback(mutable, mutable.demos[demo.id], body)); respond(response, 201, result, requestId); return; }
        if (action === 'requests/confirmations' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => confirmReadback(mutable, mutable.demos[demo.id], body)); respond(response, 201, result, requestId); return; }
        if (action === 'requests' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => saveRequest(mutable, mutable.demos[demo.id], body)); respond(response, 201, result, requestId); return; }
        if (action === 'appointments/lookup' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => lookupAppointment(mutable, mutable.demos[demo.id], body, options.lookupFailureReason?.())); respond(response, 200, result, requestId); return; }
        if (action === 'cases' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => saveCase(mutable, mutable.demos[demo.id], body)); respond(response, 201, result, requestId); return; }
        if (action === 'ending' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => beginEnding(mutable, mutable.demos[demo.id], body)); respond(response, 200, result, requestId); return; }
        // The worker owns the bounded wait. Do not race an uncancelled durable
        // transaction with a second server timer: a late commit must serialize
        // ahead of /terminal and retain its exact idempotent receipt.
        if (action === 'escalations' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => saveCase(mutable, mutable.demos[demo.id], body, true)); respond(response, 201, result, requestId); return; }
        if (action === 'terminal' && request.method === 'POST') { const body = await jsonBody(request); const result = await store.transaction((mutable) => finishTerminal(mutable, mutable.demos[demo.id], body), consumeShareOnTerminal(demo)); const terminalDemo = { ...demo, state: 'ended', terminalReason: result.reason }; await recordOwnerTestCompleted(terminalDemo); if (await endVoiceBounded(voice, terminalDemo)) { try { await finalizeVoiceCleanup(store, paidStartGate, terminalDemo); } catch { /* Durable deadline cleanup retries independently. */ } } else retryVoiceCleanupSoon(voice, store, paidStartGate, terminalDemo); respond(response, 200, result, requestId); return; }
        if ((action === 'services' || action === 'services/details') && request.method === 'POST') {
          const body = requireObject(await jsonBody(request), action === 'services' ? [] : ['serviceId']);
          if (action === 'services/details') validateContract('boundary.schema.json#/$defs/serviceDetailsInput', body);
          const result = retrievalResult(state.knowledge[demo.knowledgeRevisionId], action === 'services' ? { query: 'services' } : { query: body.serviceId, exactFactId: body.serviceId }, action === 'services' ? ['services'] : null);
          respond(response, 200, result, requestId); return;
        }
        if (action === 'runtime' && request.method === 'GET') {
          const claimed = CLAIMED_CALL_MODES.has(demo.mode) ? claimedRuntimeBinding(state, demo) : null;
          const preparation = state.preparations[demo.preparationId];
          const knowledge = claimed ? claimed.knowledge : demo.mode === 'business_demo' ? state.knowledge[demo.knowledgeRevisionId] : null;
          if (!claimed && (!preparation || preparation.workspaceId !== demo.workspaceId || preparation.revision !== demo.preparationRevision)) throw problem(409, 'runtime_binding_mismatch', 'Pinned preparation is unavailable.');
          if (demo.mode === 'business_demo') {
            const agent = state.agents[demo.agentVersionId];
            if (!knowledge || !agent || knowledge.workspaceId !== demo.workspaceId || agent.workspaceId !== demo.workspaceId || agent.knowledgeRevisionId !== knowledge.id || preparation.agentVersionId !== agent.id) throw problem(409, 'runtime_binding_mismatch', 'Pinned business knowledge is unavailable.');
          }
          const workflow = state.workflows?.[demo.id];
          const workflowRevision = workflow?.revision ?? 1;
          const hasRequestContext = workflow?.workflowId === 'WF-03' || workflow?.suspendedWorkflowId === 'WF-03';
          const businessType = demo.mode === 'frontline_qa' ? null : businessTypeFor(state, demo);
          respond(response, 200, { demoId: demo.id, mode: demo.mode, callArchitectureVersion: demo.callArchitectureVersion ?? 'legacy-v1', sessionState: demo.state, representedEntity: demo.mode === 'business_demo' || claimed ? 'business' : 'frontline', businessName: claimed ? claimed.businessName : demo.mode === 'business_demo' ? preparation?.profile?.businessName : null, profile: bundleProfile(claimed ? claimed.profile : demo.mode === 'business_demo' ? preparation?.profile : null), facts: bundleFacts(knowledge?.facts), capabilityManifest: claimed ? claimed.agent.capabilityManifest : demo.mode === 'business_demo' ? state.agents[demo.agentVersionId]?.capabilityManifest : null, agentVersionId: demo.agentVersionId ?? 'frontline-qa-v1', knowledgeRevisionId: demo.knowledgeRevisionId, generation: demo.generation, roomName: demo.roomName, workflowRevision, stateRevision: demo.stateRevision ?? 1, ...(businessType ? { businessType } : {}), currentTask: workflow?.currentTask ? publicTask(workflow.currentTask) : null, workflowId: workflow?.workflowId ?? 'WF-01', workflowPhase: workflow?.phase ?? 'interpreting', currentValidation: demo.callArchitectureVersion !== 'bob-task-v1' && hasRequestContext ? workflow?.currentValidation ?? null : null, currentReadback: demo.callArchitectureVersion !== 'bob-task-v1' && hasRequestContext ? workflow?.readback ?? null : null, setupDeadlineAt: demo.setupDeadlineAt, startedAt: demo.startedAt, softCloseAt: demo.softCloseAt, hardEndAt: demo.hardEndAt, expiresAt: demo.expiresAt, ...(claimed ? { ...CLAIMED_CALL_POLICY[demo.mode], enabledWorkflows: claimed.enabledWorkflows, receptionistName: claimed.receptionistName } : {}) }, requestId);
          return;
        }
        if (action === 'ready' && request.method === 'POST') {
          requireObject(await jsonBody(request), []);
          if (!['waiting', 'active'].includes(demo.state) || (!demo.startedAt && Date.parse(demo.setupDeadlineAt) <= Date.now() + 5_000)) throw problem(409, 'setup_expired', 'The connection window has ended. Start a new demo.');
          if (!voice?.isReady || !await voice.isReady(demo)) throw problem(409, 'media_not_ready', 'Caller and authorized worker are not both ready.');
          let stamped;
          let firstReady = false;
          try {
            stamped = await store.transaction((mutable) => {
              const current = mutable.demos[demo.id];
              if (!['waiting', 'active'].includes(current.state) || (!current.startedAt && Date.parse(current.setupDeadlineAt) <= Date.now() + 5_000)) throw problem(409, 'setup_expired', 'The connection window has ended. Start a new demo.');
              firstReady = !current.startedAt;
              if (!current.startedAt) {
                const now = Date.now();
                current.startedAt = iso(now);
                current.softCloseAt = iso(now + 270_000);
                current.hardEndAt = iso(now + 300_000);
                current.state = 'active';
              }
              return current;
            }, store instanceof PostgresStore && demo.shareGrantId ? {
              // A shared guest call becomes active only for the lease generation that started it. A late
              // worker from an earlier attempt changes nothing, and the stamp rolls back with the refusal.
              beforeCommit: async (client, _state, current) => {
                if (firstReady && !await markShareActive({ db: client, demo: current })) throw problem(409, 'stale_lease', 'This call was replaced by a newer one.');
              },
            } : undefined);
          } catch (error) {
            if (error.message === 'deadline binding conflict') throw problem(409, 'setup_expired', 'The connection window has ended. Start a new demo.');
            throw error;
          }
          if (voice?.scheduleHardEnd) voice.scheduleHardEnd(stamped);
          respond(response, 200, { demoId: demo.id, startedAt: stamped.startedAt, softCloseAt: stamped.softCloseAt, hardEndAt: stamped.hardEndAt }, requestId);
          return;
        }
        if (action === 'lookup-business-fact' && request.method === 'POST') {
          if (demo.mode !== 'business_demo' && !CLAIMED_CALL_MODES.has(demo.mode)) throw problem(403, 'wrong_mode', 'Business facts are unavailable in this mode.');
          const body = requireObject(await jsonBody(request), ['query']);
          validateContract('boundary.schema.json#/$defs/retrievalInput', body);
          respond(response, 200, retrievalResult(state.knowledge[demo.knowledgeRevisionId], body), requestId);
          return;
        }
        if (action === 'lookup-frontline-fact' && request.method === 'POST') {
          if (demo.mode !== 'frontline_qa') throw problem(403, 'wrong_mode', 'Product facts are unavailable in this mode.');
          const body = requireObject(await jsonBody(request), ['query']);
          const words = String(body.query ?? '').toLowerCase().match(/[a-z]{4,}/g)?.filter((word) => !['what', 'when', 'where', 'which', 'about', 'would', 'could', 'frontline'].includes(word)) ?? [];
          const facts = words.length ? frontlineProductKnowledge.filter((fact) => words.some((word) => `${fact.predicate} ${fact.value}`.toLowerCase().includes(word))) : frontlineProductKnowledge;
          respond(response, 200, { facts, knowledgeRevisionId: 'frontline-product-v1' }, requestId);
          return;
        }
        if (action === 'update-simulated-request' && request.method === 'POST') {
          if (demo.mode !== 'business_demo' || demo.state !== 'active') throw problem(409, 'request_unavailable', 'Appointment intake is unavailable.');
          const body = requireObject(await jsonBody(request), ['schemaVersion', 'gatheredFields', 'missingFields', 'callerConfirmed', 'operationId']);
          if (body.schemaVersion !== '1.0' || !body.gatheredFields || typeof body.gatheredFields !== 'object' || Array.isArray(body.gatheredFields) || !Array.isArray(body.missingFields) || typeof body.callerConfirmed !== 'boolean') throw problem(400, 'invalid_request', 'Appointment request fields are invalid.');
          const allowed = ['service', 'preferredDate', 'preferredTime', 'timezone', 'location', 'contactName', 'contactPhone', 'contactEmail', 'notes'];
          if (Object.keys(body.gatheredFields).some((key) => !allowed.includes(key) || typeof body.gatheredFields[key] !== 'string' || body.gatheredFields[key].length > 500) || body.missingFields.some((key) => !allowed.includes(key)) || JSON.stringify(body).length > 8_000 || (body.operationId != null && (typeof body.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.operationId)))) throw problem(400, 'invalid_request', 'Appointment request fields are invalid.');
          const gatheredFields = Object.fromEntries(Object.entries(body.gatheredFields).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
          const missingFields = [];
          if (!gatheredFields.service) missingFields.push('service');
          if (!gatheredFields.preferredDate && !gatheredFields.preferredTime) missingFields.push('preferredDate', 'preferredTime');
          if (!gatheredFields.contactName) missingFields.push('contactName');
          if (!gatheredFields.contactPhone && !gatheredFields.contactEmail) missingFields.push('contactPhone', 'contactEmail');
          const record = await store.transaction((mutable) => {
            const current = mutable.demos[demo.id];
            const now = Date.now();
            const currentWorkspace = current && mutable.workspaces[current.workspaceId];
            if (!current || !currentWorkspace || currentWorkspace.state !== 'anonymous' || Date.parse(currentWorkspace.expiresAt) <= now || current.mode !== 'business_demo' || current.state !== 'active' || !current.startedAt || !Number.isFinite(Date.parse(current.hardEndAt)) || Date.parse(current.hardEndAt) <= now || Date.parse(current.expiresAt) <= now) throw problem(409, 'request_unavailable', 'Appointment intake is unavailable.');
            const previous = mutable.requests[demo.id];
            if (body.operationId && previous?.operationId === body.operationId) return previous;
            // A model-supplied boolean cannot prove that a committed caller turn confirmed these fields.
            const next = { id: previous?.id ?? randomUUID(), demoId: current.id, preparationId: current.preparationId, knowledgeRevisionId: current.knowledgeRevisionId, agentVersionId: current.agentVersionId, schemaVersion: '1.0', operationId: body.operationId ?? null, gatheredFields, missingFields, callerConfirmed: false, simulation: true, deliveryState: 'not_sent', bookingState: 'not_booked', updatedAt: iso(now), expiresAt: current.expiresAt };
            mutable.requests[demo.id] = next;
            return next;
          });
          respond(response, 200, { appointmentRequest: record }, requestId);
          return;
        }
      }

      // With the flag off the post-onboarding routes do not exist, so the original 404 below answers.
      if (handlePostOnboarding && postOnboardingEnabled() && await handlePostOnboarding(request, response, url)) return;

      throw problem(404, 'not_found', 'API route not found.');
    } catch (error) { reject(response, error, requestId, { method: request.method, path: url.pathname }); }
  };
  const apiHandler = async (request, response, url) => {
    try {
      return store.runForRequest
        ? await store.runForRequest(request, url, () => handle(request, response, url))
        : await handle(request, response, url);
    } catch (error) {
      if (!response.headersSent) reject(response, error, randomUUID(), { method: request.method, path: url.pathname });
      else response.destroy();
    }
  };
  apiHandler.endClaimedDemo = endClaimedDemo;
  apiHandler.sweepShareLinks = sweepShareLinks;
  // Waits for background work the post-onboarding routes started after they answered (extraction, source erasure). Tests use it.
  apiHandler.postOnboardingIdle = () => (handlePostOnboarding ? handlePostOnboarding.idle() : Promise.resolve());
  let shareTimer;
  apiHandler.startShareWatchdog = ({ intervalMs = 5_000 } = {}) => {
    if (shareTimer || !(store instanceof PostgresStore)) return;
    shareTimer = setInterval(() => { void sweepShareLinks().catch(() => { /* The next sweep retries. */ }); }, intervalMs);
    shareTimer.unref?.();
  };
  apiHandler.stopShareWatchdog = () => { if (shareTimer) clearInterval(shareTimer); shareTimer = undefined; };
  if (postOnboardingEnabled()) apiHandler.startShareWatchdog();
  apiHandler.startPreparationWorker = () => preparationQueue.start();
  apiHandler.stopPreparationWorker = () => preparationQueue.stop();
  apiHandler.preparationWorkerHealthy = () => preparationQueue.healthy();
  apiHandler.researchReady = () => preparationQueue.healthy() && (!exaRequired || exaConfigured());
  apiHandler.researchReadiness = () => {
    const queueReady = Boolean(preparationQueue.healthy());
    const configuration = exaRequired ? researchConfiguration() : { ready: true, missing: [] };
    const storageMode = store instanceof PostgresStore ? 'postgres' : 'development';
    const workerReady = storageMode === 'postgres' && queueReady;
    return { ready: queueReady && configuration.ready, queueReady, workerReady, configurationReady: configuration.ready, storageMode };
  };
  return apiHandler;
}
