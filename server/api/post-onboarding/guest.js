import { randomBytes, randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { insertDemo, readDemo } from './demo-store.js';
import { mapDatabaseError, problem } from './errors.js';
import { parseCookies, sha256 } from './http.js';
import { assertHasKnowledge, businessNameFor, isDeleting, isPaused, readLineage } from './lineage.js';
import { receptionistNameOf } from './receptionist-name.js';
import { isShareToken } from './share.js';
import { dispatchVoice } from './dispatch.js';
import { buildCallSummary } from '../call-summary.js';

export const GUEST_COOKIE = 'fl_guest';
export const GUEST_FEEDBACK_WINDOW_MS = 24 * 3_600_000;
export const GUEST_CALL_MAX_SECONDS = 300;

export const DEFAULT_GUEST_CONFIG = {
  readinessSeconds: 90, sessionTtlSeconds: 24 * 3600 + 900, previewTtlSeconds: 3600,
  reservationTtlSeconds: 600, scopeDailyMax: 3, agentActiveMax: 1,
  dailyCapCents: 0, reservedCents: 0, globalConcurrent: 0, callArchitectureVersion: 'legacy-v1',
};

/**
 * `voice` is the existing LiveKit adapter contract plus one method added at connection:
 *   isConfigured(): boolean
 *   start(demo, reservation) -> { roomName, participantIdentity, participantToken, livekitUrl, dispatchId (null: token dispatch), tokenExpiresAt }
 *   end(demo): Promise<void>                 deletes the room
 *   issueParticipantToken(demo) -> { livekitUrl, participantToken, tokenExpiresAt }   (new, PO-C18)
 */

const LINK_REASONS = new Set(['unavailable', 'used', 'revoked', 'expired']);
const LINK_MESSAGE = { unavailable: 'This link is not available.', used: 'This link was used for one conversation and it has ended.', revoked: 'This link is no longer active.', expired: 'This link has expired.' };

function linkUnavailable(reason) {
  const safe = LINK_REASONS.has(reason) ? reason : 'unavailable';
  return Object.assign(problem(404, 'link_unavailable', LINK_MESSAGE[safe]), { reason: safe });
}

export function guestCookie(value, maxAgeSeconds, { secure = false } = {}) {
  return `${GUEST_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** Resolves fl_guest to its grant. The client never supplies a demo, grant or agent id. */
export async function resolveGuest(db, request) {
  const value = parseCookies(request)[GUEST_COOKIE];
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const capabilityHash = sha256(value);
  const { rows } = await db.query('SELECT * FROM resolve_guest_scope($1)', [capabilityHash]);
  const row = rows[0];
  if (!row) return null;
  return {
    capabilityHash, scopeId: row.owner_scope_id, grantId: row.grant_id, demoId: row.demo_id, sessionId: row.session_id, kind: row.kind,
    status: row.status, stableAgentId: row.stable_agent_id, agentVersionId: row.agent_version_id, leaseGeneration: row.lease_generation,
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
  };
}

const linkFacts = (businessName, name = 'Blake') => ({
  businessName, receptionistName: name, agentIdentity: `${name}, an AI assistant${businessName ? ` for ${businessName}` : ''}`,
  limits: { maxSeconds: GUEST_CALL_MAX_SECONDS, browserOnly: true }, disclosure: { ownerCanReview: true, builderMayReviewFeedback: true },
});

/** The guest page opens the link. Returns the page facts and the cookie to set. */
export async function exchangeLink({ db, token, config = DEFAULT_GUEST_CONFIG, secureCookie = false }) {
  if (!isShareToken(token)) throw linkUnavailable('unavailable');
  const previewValue = randomBytes(32).toString('hex');
  const { rows } = await db.query('SELECT * FROM share_exchange($1,$2,$3)', [sha256(token), sha256(previewValue), config.previewTtlSeconds]);
  const row = rows[0];
  if (row.reason !== 'available') throw linkUnavailable(row.reason === 'busy' ? 'unavailable' : row.reason);
  const state = await inOwnerScope(db, row.owner_scope_id, async (tx) => (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [row.owner_scope_id])).rows[0]?.state);
  // A paused receptionist answers like any unavailable link. Pausing also revokes its unused links.
  if (state && (isPaused(readLineage(state, row.stable_agent_id)) || isDeleting(readLineage(state, row.stable_agent_id)))) throw linkUnavailable('unavailable');
  const businessName = state ? businessNameFor(state, row.stable_agent_id) : null;
  return {
    body: { available: true, ...linkFacts(businessName, state ? receptionistNameOf(readLineage(state, row.stable_agent_id)) : undefined) },
    setCookie: guestCookie(previewValue, config.previewTtlSeconds, { secure: secureCookie }),
  };
}

const publicDemo = (demo) => (demo ? { demoId: demo.id, mode: demo.mode, state: demo.state, terminalReason: demo.terminalReason ?? null, setupDeadlineAt: demo.setupDeadlineAt, startedAt: demo.startedAt, softCloseAt: demo.softCloseAt, hardEndAt: demo.hardEndAt } : null);

/**
 * The only view of owner state a guest handler gets: this conversation's own record,
 * the business name, and the fixed limits. It is built here, so a guest handler cannot
 * reach knowledge, other demos, history or the agent.
 */
export async function readGuestProjection(db, guest) {
  if (guest.status === 'unused' || !guest.demoId) return { demo: null };
  const demo = await readDemo(db, guest.scopeId, guest.demoId);
  return { demo: publicDemo(demo) };
}

const DENIED = { voice_limit_reached: [429, 'voice_limit_reached', 'Calls are paused right now. Please contact the Frontline team.'], agent_busy: [409, 'link_busy', 'Someone else has started this conversation.'] };

/** POST /v1/shared/start. The reservation and grant move together or not at all. */
export async function startSharedCall({ db, guest, voice, config = DEFAULT_GUEST_CONFIG, now = new Date(), newId = randomUUID }) {
  if (!guest || !['preview', 'session'].includes(guest.kind)) throw problem(401, 'guest_session_required', 'Open the link again.');
  if (!voice?.isConfigured?.()) throw problem(503, 'voice_unavailable', 'Voice is not available yet.');
  const demoId = newId();
  const sessionId = newId();
  let reserved;
  try {
    reserved = await inOwnerScope(db, guest.scopeId, async (tx) => {
      const row = (await tx.query('SELECT * FROM share_start_reserve($1,$2::uuid,$3::uuid,$4,$5)', [guest.capabilityHash, demoId, sessionId, config.sessionTtlSeconds, config.readinessSeconds])).rows[0];
      if (row.outcome !== 'reserved') return { outcome: row.outcome, row };
      const state = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [guest.scopeId])).rows[0]?.state;
      const lineage = state && readLineage(state, row.stable_agent_id);
      // Throwing rolls the whole transaction back, so the link stays as it was.
      if (isPaused(lineage) || isDeleting(lineage)) throw linkUnavailable('unavailable');
      assertHasKnowledge(state, lineage);
      const reservation = (await tx.query('SELECT * FROM reserve_voice_start_claimed($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10)',
        [guest.scopeId, row.stable_agent_id, 'shared_guest', row.grant_id, config.dailyCapCents, config.reservedCents, config.globalConcurrent, config.reservationTtlSeconds, config.scopeDailyMax, config.agentActiveMax])).rows[0];
      // Throwing rolls the whole transaction back, so the link stays unused.
      if (!reservation.approved) throw Object.assign(new Error('voice_reservation_denied'), { denied: reservation.reason });
      if (!(await tx.query('SELECT share_bind_reservation($1::uuid,$2,$3::uuid) AS bound', [row.grant_id, row.lease_generation, reservation.reservation_id])).rows[0].bound) throw new Error('share_bind_failed');
      const revision = lineage?.revisions.find((item) => item.agentVersionId === row.agent_version_id);
      if (!revision) throw problem(409, 'agent_not_ready', 'Blake is not ready to share.');
      const demo = {
        receptionistName: receptionistNameOf(lineage), id: demoId, workspaceId: guest.scopeId, preparationId: null, preparationRevision: null, mode: 'shared_guest',
        callArchitectureVersion: config.callArchitectureVersion, stableAgentId: row.stable_agent_id, agentVersionId: row.agent_version_id,
        knowledgeRevisionId: revision.knowledgeRevisionId, roomName: `frontline-demo-${demoId}`, generation: 1, leaseGeneration: row.lease_generation,
        reservationId: reservation.reservation_id, state: 'dispatching', stateRevision: 1, reconnectAllowed: true, terminalReason: null,
        createdAt: now.toISOString(), setupDeadlineAt: new Date(now.getTime() + 20_000).toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), startedAt: null, softCloseAt: null, hardEndAt: null,
        shareGrantId: row.grant_id, guestSessionId: sessionId,
      };
      await insertDemo(tx, guest.scopeId, demo);
      return { outcome: 'reserved', row, demo };
    });
  } catch (error) {
    if (error?.denied) { const [status, code, message] = DENIED[error.denied] ?? [503, 'voice_unavailable', 'Voice is not available yet.']; throw problem(status, code, message); }
    throw mapDatabaseError(error);
  }
  if (reserved.outcome === 'replay') return { credentials: await reconnectSharedCall({ db, guest: { ...guest, kind: 'session', demoId: reserved.row.demo_id }, voice, now }), replayed: true };
  if (reserved.outcome === 'busy') throw problem(409, 'link_busy', 'Someone else has started this conversation.');
  if (reserved.outcome === 'used') throw Object.assign(problem(409, 'link_used', 'This link was used for one conversation.'), { reason: 'used' });
  if (reserved.outcome !== 'reserved') throw linkUnavailable(reserved.outcome);

  const { demo, row } = reserved;
  const credentials = await dispatchVoice({
    db, scopeId: guest.scopeId, demo, voice, failureMessage: "This link can't start right now.",
    onRelease: (tx) => tx.query('SELECT share_release_reservation($1::uuid,$2)', [row.grant_id, row.lease_generation]),
  });
  return { credentials };
}

/** Fresh room credentials for the same room, only while the conversation can still run. */
export async function reconnectSharedCall({ db, guest, voice, now = new Date() }) {
  if (!guest || guest.kind !== 'session' || !guest.demoId) throw problem(401, 'guest_session_required', 'Open the link again.');
  const demo = await readDemo(db, guest.scopeId, guest.demoId);
  if (!demo || ['ending', 'terminal', 'ended', 'failed'].includes(demo.state) || demo.reconnectAllowed === false) throw problem(409, 'session_ended', 'This conversation has ended.');
  // A start whose dispatch never completed has no room to rejoin, and no second session may start.
  if (demo.state === 'dispatching') throw problem(503, 'voice_unavailable', 'This link can\'t start right now.');
  const deadline = Date.parse(demo.hardEndAt ?? demo.setupDeadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now.getTime()) throw problem(409, 'session_ended', 'This conversation has ended.');
  const token = await voice.issueParticipantToken(demo);
  return { demoId: demo.id, livekitUrl: token.livekitUrl, participantToken: token.participantToken, tokenExpiresAt: token.tokenExpiresAt, hardEndAt: demo.hardEndAt, setupDeadlineAt: demo.setupDeadlineAt };
}

/**
 * The guest's own session, with the facts the page shows (the receptionist's name and the business). A page reload
 * has only the cookie (the token is already gone from the address bar), so these come back at every link status:
 * the entry page, a rejoined call and the result all name the receptionist.
 */
export async function guestSession({ db, guest }) {
  if (!guest) throw problem(401, 'guest_session_required', 'Open the link again.');
  const { demo } = await readGuestProjection(db, guest);
  const state = await inOwnerScope(db, guest.scopeId, async (tx) => (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [guest.scopeId])).rows[0]?.state);
  return { linkStatus: guest.status, demo, link: linkFacts(state ? businessNameFor(state, guest.stableAgentId) : null, state ? receptionistNameOf(readLineage(state, guest.stableAgentId)) : undefined) };
}

/**
 * The guest's own result: the demo record, the summary of this conversation only (built here, so nothing else in
 * the scope can reach the page), and whether the 24 hour feedback window is still open.
 */
export async function guestResult({ db, guest, now = new Date() }) {
  const { demo } = await readGuestProjection(db, guest);
  if (!demo) throw problem(401, 'guest_session_required', 'Open the link again.');
  const over = guest.status === 'consumed' || ['ended', 'terminal', 'failed'].includes(demo.state);
  const callSummary = over ? await inOwnerScope(db, guest.scopeId, async (tx) => {
    const state = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [guest.scopeId])).rows[0]?.state;
    const record = state?.demos?.[guest.demoId];
    return record?.mode === 'shared_guest' ? buildCallSummary(state, record) : null;
  }) : null;
  const closesAt = guest.status === 'consumed' && guest.consumedAt ? new Date(guest.consumedAt.getTime() + GUEST_FEEDBACK_WINDOW_MS) : null;
  return { ...demo, linkStatus: guest.status, callSummary, feedbackClosesAt: closesAt ? closesAt.toISOString() : null, feedbackOpen: Boolean(closesAt && now.getTime() <= closesAt.getTime()) };
}

/** The guest may send feedback only after their conversation ended, for 24 hours. */
export function guestFeedbackActor(guest, now = new Date()) {
  if (!guest || guest.kind !== 'session' || guest.status !== 'consumed' || !guest.consumedAt) throw problem(401, 'guest_session_required', 'Finish your conversation first.');
  if (now.getTime() > guest.consumedAt.getTime() + GUEST_FEEDBACK_WINDOW_MS) throw problem(403, 'feedback_window_closed', 'Feedback is closed for this conversation.');
  return {
    scopeId: guest.scopeId, stableAgentId: guest.stableAgentId, currentAgentVersionId: guest.agentVersionId, knownAgentVersionIds: [guest.agentVersionId],
    creatorKind: 'guest_session', creatorRef: sha256(guest.sessionId), conversationId: guest.demoId,
    conversationExists: async (id) => id === guest.demoId,
  };
}
