import { randomUUID } from 'node:crypto';
import { exchangeLink, guestFeedbackActor, guestResult, guestSession, reconnectSharedCall, resolveGuest, startSharedCall } from './guest.js';
import { createShare, listShares, revokeShare } from './share.js';
import { endOwnerTest, ownerTestResult, startOwnerTest } from './owner-test.js';
import { getConversation, listConversations, prepareRecaps, reviewOutcome } from './conversations.js';
import { appendAssistantTurn } from './assistant-turns.js';
import { getSourceErasure, runSourceErasure, startSourceErasure } from './source-erasure.js';
import { getAgentSummary, listMyAgents, recordFirstVisit } from './me.js';
import { renameReceptionist } from './rename.js';
import { createReceptionist, resolveCreateTarget } from './create-receptionist.js';
import { pauseReceptionist, resumeReceptionist } from './receptionist-status.js';
import { runReceptionistDeletion, startReceptionistDeletion } from './receptionist-deletion.js';
import { runAccountDeletion, startAccountDeletion } from './account-deletion.js';
import { signedOutCookies } from '../auth-claims.js';
import { applyKnowledgeUpdate, cancelKnowledgeUpdate, createKnowledgeUpdate, getKnowledgeUpdate, markVersionReviewed, readCapabilities, readKnowledge, reopenKnowledgeUpdate, runExtraction, saveCapabilities, saveKnowledgeSelection } from './knowledge-updates.js';
import { createCliCode, exchangeCliCode, isBuilderSession, isCredentialToken, revokeCredential, revokeCurrentCredential } from './builder-auth.js';
import { problem } from './errors.js';
import { getFeedback, parseIdempotencyKey, searchFeedback, submitFeedback, updateFeedbackStatus } from './feedback.js';
import { createRateLimiter, csrfGuard, originGuard, parseCookies, readJson, sendJson, sendProblem, sha256 } from './http.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AGENT_FEEDBACK = new RegExp(`^/v1/agents/(${UUID})/feedback$`);
const BUILDER_FEEDBACK_ONE = new RegExp(`^/v1/builder/feedback/(${UUID})$`);
const BUILDER_CREDENTIAL_ONE = new RegExp(`^/v1/builder/credentials/(${UUID})$`);
const AGENT_SHARES = new RegExp(`^/v1/agents/(${UUID})/shares$`);
const AGENT_SHARE_ONE = new RegExp(`^/v1/agents/(${UUID})/shares/(${UUID})$`);
const AGENT_KNOWLEDGE = new RegExp(`^/v1/agents/(${UUID})/knowledge$`);
const AGENT_UPDATES = new RegExp(`^/v1/agents/(${UUID})/knowledge-updates$`);
const AGENT_UPDATE_ACTION = new RegExp(`^/v1/agents/(${UUID})/knowledge-updates/(${UUID})(?:/(apply|cancel|reopen))?$`);
const AGENT_CAPABILITIES = new RegExp(`^/v1/agents/(${UUID})/capabilities$`);
const AGENT_VERSION_REVIEW = new RegExp(`^/v1/agents/(${UUID})/versions/(${UUID})/review$`);
const AGENT_TESTS = new RegExp(`^/v1/agents/(${UUID})/tests$`);
const AGENT_TEST_ONE = new RegExp(`^/v1/agents/(${UUID})/tests/(${UUID})/(result|end)$`);
const AGENT_CONVERSATIONS = new RegExp(`^/v1/agents/(${UUID})/conversations$`);
const AGENT_CONVERSATION_ONE = new RegExp(`^/v1/agents/(${UUID})/conversations/(${UUID})$`);
const AGENT_OUTCOME_REVIEW = new RegExp(`^/v1/agents/(${UUID})/conversations/(${UUID})/outcomes/(${UUID})/review$`);
const ASSISTANT_TURNS = new RegExp(`^/v1/internal/demos/(${UUID})/assistant-turns$`);
const AGENT_SOURCE_ERASE = new RegExp(`^/v1/agents/(${UUID})/knowledge-sources/([A-Za-z0-9_-]{1,64})/erase$`);
const AGENT_SOURCE_ERASE_JOB = new RegExp(`^/v1/agents/(${UUID})/knowledge-sources/([A-Za-z0-9_-]{1,64})/erase/(${UUID})$`);
const AGENT_SOURCE_SELECTION = new RegExp(`^/v1/agents/(${UUID})/knowledge-sources-selection$`);
const ME_AGENTS = '/v1/me/agents';
const ME_ACCOUNT = '/v1/me/account';
const AGENT_SUMMARY = new RegExp(`^/v1/agents/(${UUID})/summary$`);
const AGENT_FIRST_VISIT = new RegExp(`^/v1/agents/(${UUID})/first-visit$`);
const AGENT_NAME = new RegExp(`^/v1/agents/(${UUID})/name$`);
const AGENT_PAUSE = new RegExp(`^/v1/agents/(${UUID})/pause$`);
const AGENT_RESUME = new RegExp(`^/v1/agents/(${UUID})/resume$`);
const AGENT_ONE = new RegExp(`^/v1/agents/(${UUID})$`);
const OWNER_PATHS = [AGENT_FEEDBACK, AGENT_SHARES, AGENT_SHARE_ONE, AGENT_KNOWLEDGE, AGENT_UPDATES, AGENT_UPDATE_ACTION, AGENT_CAPABILITIES, AGENT_VERSION_REVIEW, AGENT_TESTS, AGENT_TEST_ONE, AGENT_CONVERSATIONS, AGENT_CONVERSATION_ONE, AGENT_OUTCOME_REVIEW, AGENT_SUMMARY, AGENT_FIRST_VISIT, AGENT_SOURCE_ERASE, AGENT_SOURCE_ERASE_JOB, AGENT_SOURCE_SELECTION, AGENT_PAUSE, AGENT_RESUME, AGENT_NAME, AGENT_ONE];
const ownsPath = (path) => path === ME_AGENTS || path === ME_ACCOUNT || path.startsWith('/v1/builder/') || path.startsWith('/v1/shared/') || ASSISTANT_TURNS.test(path) || OWNER_PATHS.some((pattern) => pattern.test(path));

/**
 * Creates the request handler for the post-onboarding routes implemented so far.
 * It returns true when it handled (and answered) the request, false otherwise, so
 * that connection (PO-C14) is one line in the existing handler chain.
 *
 * ctx:
 *   enabled()                              feature flag FRONTLINE_POST_ONBOARDING
 *   db                                     see database.js
 *   owner(request, stableAgentId)          resolves the owner actor or returns null
 *                                          (see feedback.js submitFeedback for the shape)
 *   appBaseUrl                             origin used to build share links
 *   voice                                  see guest.js (the LiveKit adapter contract)
 *   guestConfig                            see guest.js DEFAULT_GUEST_CONFIG
 *   endLiveCall({scopeId, demoId, sessionId, reservationId, reason})   ends a live conversation through the
 *                                          normal terminal path (connection PO-C1); also used by source erasure
 *   endGuestDemo({scopeId, demoId})        the guest's own end request, same terminal path
 *   endOwnerDemo({scopeId, demoId})        the owner ending a test call, same terminal path
 *   worker(request, demoId)                resolves the voice worker's credential to {scopeId} or null
 *   secureCookie                           add Secure to the guest cookie
 *   extraction                             { available: {text, url, document}, extract({inputType, inputRef}) } the
 *                                          model and parser boundary (see knowledge-updates.js runExtraction)
 *   newId                                  optional id generator (tests)
 */
export function createPostOnboardingHandler(ctx) {
  // Writes are the costly calls; reads are polled (extraction, apply) so they get a larger budget.
  const writeLimit = createRateLimiter({ limit: ctx.limits?.ownerWrite ?? 30 });
  const readLimit = createRateLimiter({ limit: ctx.limits?.ownerRead ?? 120 });
  const ownerLimit = (scopeId, method) => (method === 'GET' ? readLimit(scopeId) : writeLimit(scopeId));
  // Extraction runs after the request that started it has answered. Tests wait on `idle()`.
  const pending = new Set();
  function schedule(job) {
    const running = job().catch(() => {});
    pending.add(running);
    running.finally(() => pending.delete(running));
  }
  const builderLimit = createRateLimiter({ limit: 120 });
  const guestLimit = createRateLimiter({ limit: ctx.limits?.guest ?? 60 });

  function builderCredential(request) {
    const authorization = String(request.headers.authorization ?? '');
    if (authorization) {
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      if (!isCredentialToken(token)) throw problem(401, 'credential_invalid', 'The credential is missing, expired or revoked.');
      return { kind: 'credential', token };
    }
    const sessionToken = parseCookies(request).fl_auth;
    if (!sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken)) throw problem(401, 'credential_invalid', 'Sign in or use a builder credential.');
    csrfGuard(request);
    return { kind: 'session', sessionToken };
  }
  const sessionOnly = (request) => {
    const credential = builderCredential(request);
    if (credential.kind !== 'session') throw problem(403, 'credential_read_only', 'Sign in as a builder to do this.');
    return credential;
  };

  async function readEmptyBody(request) {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw problem(400, 'invalid_field', 'Send an empty JSON object.');
  }

  async function route(request, response, url, requestId) {
    const { pathname, searchParams } = url;
    const method = request.method;
    let match;

    if ((match = pathname.match(AGENT_FEEDBACK)) && method === 'POST') {
      csrfGuard(request);
      const actor = await ctx.owner(request, match[1]);
      if (!actor) throw problem(404, 'not_found', 'Agent not found.');
      ownerLimit(actor.scopeId, method);
      const { receipt, replayed } = await submitFeedback({ db: ctx.db, actor, body: await readJson(request, { maxBytes: 65_536 }), idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']), now: ctx.now?.() });
      sendJson(response, 201, receipt, requestId, replayed ? { 'idempotent-replay': 'true' } : {});
      return;
    }

    if (pathname === ME_AGENTS && method === 'GET') {
      csrfGuard(request);
      sendJson(response, 200, await listMyAgents({ db: ctx.db, request, voiceConfigured: Boolean(ctx.voice?.isConfigured?.()) }), requestId);
      return;
    }

    if (pathname === ME_AGENTS && method === 'POST') {
      csrfGuard(request);
      const body = await readJson(request);
      const target = await resolveCreateTarget({ db: ctx.db, request, siblingAgentId: body?.siblingAgentId });
      ownerLimit(target.scopeId, method);
      const { summary, replayed } = await createReceptionist({ db: ctx.db, target, body, idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']), voiceConfigured: Boolean(ctx.voice?.isConfigured?.()), now: ctx.now?.(), ...(ctx.newId ? { newId: ctx.newId } : {}) });
      sendJson(response, 201, summary, requestId, replayed ? { 'idempotent-replay': 'true' } : {});
      return;
    }

    // PO-A20. Deletes the signed-in person's whole account. The person comes from the fl_auth session only. The answer
    // ends the browser's sign-in (session and profile cookies), and a repeat with the same session answers the same way.
    if (pathname === ME_ACCOUNT && method === 'DELETE') {
      csrfGuard(request);
      writeLimit(`account:${sha256(parseCookies(request).fl_auth ?? '')}`);
      const started = await startAccountDeletion({ db: ctx.db, request, endLiveCall: ctx.endLiveCall, ...(ctx.newId ? { newId: ctx.newId } : {}) });
      if (started.created || started.resumed) schedule(() => runAccountDeletion({ db: ctx.db, jobId: started.jobId, endLiveCall: ctx.endLiveCall }));
      sendJson(response, 202, started.response, requestId, { 'set-cookie': signedOutCookies() });
      return;
    }

    const ownerAction = OWNER_PATHS.slice(3).some((pattern) => pattern.test(pathname));
    if (ownerAction) {
      csrfGuard(request);
      match = OWNER_PATHS.slice(3).map((pattern) => pathname.match(pattern)).find(Boolean);
      // Only the delete route may see a receptionist that is being deleted, so a repeated delete answers with the same job.
      const actor = await ctx.owner(request, match[1], { allowDeleting: AGENT_ONE.test(pathname) && method === 'DELETE' });
      if (!actor) throw problem(404, 'not_found', 'Agent not found.');
      ownerLimit(actor.scopeId, method);
      const key = parseIdempotencyKey(request.headers['idempotency-key']);
      const common = { db: ctx.db, actor, now: ctx.now?.(), ...(ctx.newId ? { newId: ctx.newId } : {}) };
      const replay = (replayed) => (replayed ? { 'idempotent-replay': 'true' } : {});
      if (AGENT_SUMMARY.test(pathname) && method === 'GET') { sendJson(response, 200, await getAgentSummary({ ...common, voiceConfigured: Boolean(ctx.voice?.isConfigured?.()) }), requestId); return; }
      if (AGENT_NAME.test(pathname) && method === 'PATCH') { sendJson(response, 200, await renameReceptionist({ ...common, body: await readJson(request) }), requestId); return; }
      if (AGENT_FIRST_VISIT.test(pathname) && method === 'POST') { sendJson(response, 200, await recordFirstVisit({ ...common, body: await readJson(request) }), requestId); return; }
      if (AGENT_ONE.test(pathname) && method === 'DELETE') {
        const started = await startReceptionistDeletion({ ...common, endLiveCall: ctx.endLiveCall });
        if (started.created || started.resumed) schedule(() => runReceptionistDeletion({ db: ctx.db, scopeId: actor.scopeId, jobId: started.jobId, endLiveCall: ctx.endLiveCall, now: () => ctx.now?.() ?? new Date() }));
        sendJson(response, 202, started.response, requestId);
        return;
      }
      if (AGENT_PAUSE.test(pathname) && method === 'POST') { await readEmptyBody(request); sendJson(response, 200, await pauseReceptionist({ ...common, endLiveCall: ctx.endLiveCall }), requestId); return; }
      if (AGENT_RESUME.test(pathname) && method === 'POST') { await readEmptyBody(request); sendJson(response, 200, await resumeReceptionist(common), requestId); return; }
      if (AGENT_KNOWLEDGE.test(pathname) && method === 'GET') { sendJson(response, 200, await readKnowledge({ ...common, extractionAvailable: ctx.extraction?.available ?? {} }), requestId); return; }
      if (AGENT_UPDATES.test(pathname) && method === 'POST') {
        const created = await createKnowledgeUpdate({ ...common, body: await readJson(request, { maxBytes: 65_536 }), idempotencyKey: key, extractionAvailable: ctx.extraction?.available ?? {} });
        if (created.extractNow) schedule(() => runExtraction({ db: ctx.db, actor, updateId: created.update.updateId, extraction: ctx.extraction, now: () => ctx.now?.() ?? new Date(), ...(ctx.newId ? { newId: ctx.newId } : {}) }));
        sendJson(response, 202, { update: created.update }, requestId, replay(created.replayed));
        return;
      }
      if (AGENT_UPDATE_ACTION.test(pathname)) {
        const [, , updateId, action] = match;
        if (!action && method === 'GET') { sendJson(response, 200, await getKnowledgeUpdate({ ...common, updateId }), requestId); return; }
        if (action === 'apply' && method === 'POST') {
          const applied = await applyKnowledgeUpdate({ ...common, updateId, body: await readJson(request, { maxBytes: 65_536 }), idempotencyKey: key });
          sendJson(response, 202, { update: applied.update }, requestId, replay(applied.replayed));
          return;
        }
        if (action === 'cancel' && method === 'POST') { sendJson(response, 200, await cancelKnowledgeUpdate({ ...common, updateId, body: await readJson(request) }), requestId); return; }
        if (action === 'reopen' && method === 'POST') { sendJson(response, 200, await reopenKnowledgeUpdate({ ...common, updateId }), requestId); return; }
      }
      if (AGENT_SOURCE_ERASE.test(pathname) && method === 'POST') {
        const started = await startSourceErasure({ ...common, sourceId: match[2], body: await readJson(request) });
        if (started.created || started.resumed) schedule(() => runSourceErasure({ db: ctx.db, scopeId: actor.scopeId, jobId: started.jobId, endLiveCall: ctx.endLiveCall, now: () => ctx.now?.() ?? new Date() }));
        sendJson(response, 202, started.job, requestId);
        return;
      }
      if (AGENT_SOURCE_ERASE_JOB.test(pathname) && method === 'GET') { sendJson(response, 200, await getSourceErasure({ ...common, sourceId: match[2], jobId: match[3] }), requestId); return; }
      if (AGENT_SOURCE_SELECTION.test(pathname) && method === 'PUT') {
        const { replayed, ...saved } = await saveKnowledgeSelection({ ...common, body: await readJson(request), idempotencyKey: key });
        sendJson(response, 200, saved, requestId, replay(replayed));
        return;
      }
      if (AGENT_CAPABILITIES.test(pathname)) {
        if (method === 'GET') { sendJson(response, 200, await readCapabilities(common), requestId); return; }
        if (method === 'PATCH') {
          const { replayed, ...saved } = await saveCapabilities({ ...common, body: await readJson(request), idempotencyKey: key });
          sendJson(response, 200, saved, requestId, replay(replayed));
          return;
        }
      }
      if (AGENT_VERSION_REVIEW.test(pathname) && method === 'POST') { sendJson(response, 200, await markVersionReviewed({ ...common, versionId: match[2], body: await readJson(request) }), requestId); return; }
      if (AGENT_TESTS.test(pathname) && method === 'POST') {
        sendJson(response, 201, await startOwnerTest({ ...common, voice: ctx.voice, config: ctx.guestConfig, body: await readJson(request) }), requestId);
        return;
      }
      if (AGENT_TEST_ONE.test(pathname)) {
        const [, , demoId, action] = match;
        if (action === 'result' && method === 'GET') { sendJson(response, 200, await ownerTestResult({ ...common, demoId }), requestId); return; }
        if (action === 'end' && method === 'POST') { sendJson(response, 200, await endOwnerTest({ ...common, demoId, endOwnerDemo: ctx.endOwnerDemo }), requestId); return; }
      }
      if (AGENT_CONVERSATIONS.test(pathname) && method === 'GET') {
        const page = await listConversations({ ...common, query: Object.fromEntries(searchParams) });
        sendJson(response, 200, page, requestId);
        // The first page's newest finished calls get their recaps ready while the owner reads the list.
        if (ctx.writeRecap && !searchParams.get('cursor')) schedule(() => prepareRecaps({ ...common, conversations: page.conversations, writeRecap: ctx.writeRecap }));
        return;
      }
      if (AGENT_CONVERSATION_ONE.test(pathname) && method === 'GET') { sendJson(response, 200, await getConversation({ ...common, conversationId: match[2], writeRecap: ctx.writeRecap ?? null }), requestId); return; }
      if (AGENT_OUTCOME_REVIEW.test(pathname) && method === 'POST') { sendJson(response, 200, await reviewOutcome({ ...common, conversationId: match[2], recordId: match[3], body: await readJson(request) }), requestId); return; }
      throw problem(404, 'not_found', 'Not found.');
    }

    if ((match = pathname.match(ASSISTANT_TURNS)) && method === 'POST') {
      // The worker's own credential, resolved by the existing internal auth (connection PO-C1). No cookie, no CSRF.
      const worker = await ctx.worker?.(request, match[1]);
      if (!worker) throw problem(404, 'not_found', 'Not found.');
      sendJson(response, 201, await appendAssistantTurn({ db: ctx.db, scopeId: worker.scopeId, demoId: match[1], body: await readJson(request), now: ctx.now?.() }), requestId);
      return;
    }

    if ((match = pathname.match(AGENT_SHARES))) {
      csrfGuard(request);
      const actor = await ctx.owner(request, match[1]);
      if (!actor) throw problem(404, 'not_found', 'Agent not found.');
      ownerLimit(actor.scopeId, method);
      if (method === 'GET') { sendJson(response, 200, await listShares({ db: ctx.db, actor }), requestId); return; }
      if (method === 'POST') {
        if (!ctx.voice?.isConfigured?.()) throw problem(503, 'voice_unavailable', 'Sharing is not available right now.');
        const { share, replayed } = await createShare({ db: ctx.db, actor, appBaseUrl: ctx.appBaseUrl, body: await readJson(request), idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']), now: ctx.now?.() });
        sendJson(response, 201, share, requestId, replayed ? { 'idempotent-replay': 'true' } : {});
        return;
      }
    }
    if ((match = pathname.match(AGENT_SHARE_ONE)) && method === 'DELETE') {
      csrfGuard(request);
      const actor = await ctx.owner(request, match[1]);
      if (!actor) throw problem(404, 'not_found', 'Agent not found.');
      ownerLimit(actor.scopeId, method);
      sendJson(response, 200, await revokeShare({ db: ctx.db, actor, shareId: match[2], expectedVersion: Number(searchParams.get('expectedVersion')), endLiveCall: ctx.endLiveCall }), requestId);
      return;
    }

    if (pathname.startsWith('/v1/shared/')) {
      // Guests carry no CSRF pair. Their cookie is SameSite=Strict, the origin is checked, and every
      // state change needs a custom header or a JSON body, which a cross-site form cannot send.
      originGuard(request, method === 'GET');
      if (method !== 'GET' && !request.headers['x-frontline-guest'] && !String(request.headers['content-type'] ?? '').startsWith('application/json')) throw problem(403, 'csrf_failed', 'Refresh the page and try again.');
      guestLimit(request.socket?.remoteAddress ?? 'unknown');
      const guestConfig = ctx.guestConfig;
      if (pathname === '/v1/shared/exchange' && method === 'POST') {
        const { body, setCookie } = await exchangeLink({ db: ctx.db, token: (await readJson(request)).token, config: guestConfig, secureCookie: ctx.secureCookie });
        sendJson(response, 200, body, requestId, { 'set-cookie': setCookie });
        return;
      }
      const guest = await resolveGuest(ctx.db, request);
      if (!guest) throw problem(401, 'guest_session_required', 'Open the link again.');
      if (pathname === '/v1/shared/start' && method === 'POST') {
        const { credentials } = await startSharedCall({ db: ctx.db, guest, voice: ctx.voice, config: guestConfig, now: ctx.now?.() });
        sendJson(response, 201, credentials, requestId);
        return;
      }
      if (pathname === '/v1/shared/session' && method === 'GET') { sendJson(response, 200, await guestSession({ db: ctx.db, guest }), requestId); return; }
      if (pathname === '/v1/shared/reconnect' && method === 'POST') { sendJson(response, 200, await reconnectSharedCall({ db: ctx.db, guest, voice: ctx.voice, now: ctx.now?.() }), requestId); return; }
      if (pathname === '/v1/shared/end' && method === 'POST') {
        if (guest.kind !== 'session' || !guest.demoId) throw problem(401, 'guest_session_required', 'Open the link again.');
        sendJson(response, 200, await ctx.endGuestDemo({ scopeId: guest.scopeId, demoId: guest.demoId }), requestId);
        return;
      }
      if (pathname === '/v1/shared/result' && method === 'GET') { sendJson(response, 200, await guestResult({ db: ctx.db, guest, now: ctx.now?.() }), requestId); return; }
      if (pathname === '/v1/shared/feedback' && method === 'POST') {
        const actor = guestFeedbackActor(guest, ctx.now?.());
        const { receipt, replayed } = await submitFeedback({ db: ctx.db, actor, body: await readJson(request, { maxBytes: 65_536 }), idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']), now: ctx.now?.() });
        sendJson(response, 201, receipt, requestId, replayed ? { 'idempotent-replay': 'true' } : {});
        return;
      }
    }

    if (pathname === '/v1/builder/feedback' && method === 'GET') {
      const credential = builderCredential(request);
      builderLimit(sha256(credential.token ?? credential.sessionToken));
      sendJson(response, 200, await searchFeedback({ db: ctx.db, credential, query: Object.fromEntries(searchParams) }), requestId);
      return;
    }
    if ((match = pathname.match(BUILDER_FEEDBACK_ONE))) {
      if (method === 'GET') {
        const credential = builderCredential(request);
        builderLimit(sha256(credential.token ?? credential.sessionToken));
        sendJson(response, 200, { record: await getFeedback({ db: ctx.db, credential, id: match[1] }) }, requestId);
        return;
      }
      if (method === 'PATCH') {
        const credential = sessionOnly(request);
        sendJson(response, 200, { record: await updateFeedbackStatus({ db: ctx.db, credential, id: match[1], body: await readJson(request) }) }, requestId);
        return;
      }
    }

    if (pathname === '/v1/builder/session' && method === 'GET') {
      const credential = sessionOnly(request);
      sendJson(response, 200, { builder: await isBuilderSession({ db: ctx.db, sessionToken: credential.sessionToken }) }, requestId);
      return;
    }
    // The signed-in approval page mints a one-time code bound to the CLI's PKCE challenge.
    if (pathname === '/v1/builder/credentials' && method === 'POST') {
      const { sessionToken } = sessionOnly(request);
      const body = await readJson(request);
      sendJson(response, 201, await createCliCode({ db: ctx.db, sessionToken, challenge: body.challenge, label: body.label }), requestId);
      return;
    }
    // The CLI exchanges the code plus its verifier for the read-only token. No cookie, so no CSRF.
    if (pathname === '/v1/builder/credentials/exchange' && method === 'POST') {
      builderLimit(`exchange:${request.socket?.remoteAddress ?? 'unknown'}`);
      const body = await readJson(request);
      sendJson(response, 201, await exchangeCliCode({ db: ctx.db, code: body.code, verifier: body.verifier }), requestId);
      return;
    }
    if (pathname === '/v1/builder/credentials/current' && method === 'DELETE') {
      const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '').trim();
      await revokeCurrentCredential({ db: ctx.db, token });
      sendJson(response, 200, { revoked: true }, requestId);
      return;
    }
    if ((match = pathname.match(BUILDER_CREDENTIAL_ONE)) && method === 'DELETE') {
      const { sessionToken } = sessionOnly(request);
      await revokeCredential({ db: ctx.db, sessionToken, id: match[1] });
      sendJson(response, 200, { revoked: true }, requestId);
      return;
    }
    throw problem(404, 'not_found', 'Not found.');
  }

  async function handlePostOnboarding(request, response, url) {
    if (!ownsPath(url.pathname)) return false;
    const requestId = randomUUID();
    try {
      if (!ctx.enabled?.()) throw problem(503, 'feature_disabled', 'This is not available right now.');
      await route(request, response, url, requestId);
    } catch (error) {
      sendProblem(response, error, requestId);
    }
    return true;
  }
  return Object.assign(handlePostOnboarding, { idle: async () => { while (pending.size) await Promise.all([...pending]); } });
}
