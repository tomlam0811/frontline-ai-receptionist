import { randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { insertDemo, readDemo } from './demo-store.js';
import { dispatchVoice } from './dispatch.js';
import { mapDatabaseError, problem } from './errors.js';
import { assertHasKnowledge, assertNotDeleting, assertNotPaused, ensureLineage, readLineage, versionNumbers } from './lineage.js';
import { withOwnerState } from './owner-state.js';
import { DEFAULT_RECEPTIONIST_NAME, receptionistNameOf } from './receptionist-name.js';
import { unavailableVersionIds } from './source-redaction.js';
import { buildCallSummary } from '../call-summary.js';
import { withNextSteps } from '../next-step.js';

// Owner test calls (technical spec PO-E13, PO-E14). A test call talks to the owner's current
// version of Bob, uses the same paid-voice budget as every other call, and never counts as a
// customer conversation.

const DENIED = {
  voice_limit_reached: () => [429, 'voice_limit_reached', 'Test calls are paused right now. Please contact the Frontline team.'],
  test_limit_reached: () => [429, 'test_limit_reached', `You've used today's ${OWNER_TEST_DAILY_MAX} test calls. The limit resets at midnight Pacific time.`],
  agent_busy: (name) => [409, 'agent_busy', `${name} is already on a call. End it first.`],
};
export const OWNER_TEST_RETENTION_DAYS = 30;
// Tom (2026-10-02): each account gets 3 test calls per Pacific calendar day. FRONTLINE_OWNER_TEST_DAILY_MAX raises it
// for testing without a code change (2026-10-06).
export const OWNER_TEST_DAILY_MAX = Math.max(1, Math.floor(Number(process.env.FRONTLINE_OWNER_TEST_DAILY_MAX)) || 3);

const pacificDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function ownerTestDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(pacificDayFormatter.formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Owner test starts on this scope's Pacific calendar date; failed starts do not count. */
const testsToday = (state, now) => Object.values(state.demos ?? {}).filter((demo) => demo.mode === 'owner_test'
  && demo.state !== 'failed' && ownerTestDayKey(demo.createdAt) === ownerTestDayKey(now)).length;

/** Starts a test call. Reservation and demo record are created together; dispatch failure releases the reservation only once the room is gone. */
export async function startOwnerTest({ db, actor, voice, config, body, now = new Date(), newId = /** @type {() => string} */ (() => randomUUID()) }) {
  if (typeof body?.expectedAgentVersionId !== 'string') throw problem(400, 'invalid_field', 'expectedAgentVersionId: send the version you are testing.');
  if (!voice?.isConfigured?.()) throw problem(503, 'voice_unavailable', 'Test calls are not available right now.');
  const demoId = newId();
  let demo;
  try {
    demo = await inOwnerScope(db, actor.scopeId, async (tx) => {
      const state = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR UPDATE', [actor.scopeId])).rows[0]?.state;
      const lineage = state && readLineage(state, actor.stableAgentId);
      if (!lineage) throw problem(404, 'not_found', 'Not found.');
      assertNotDeleting(lineage);
      assertNotPaused(lineage);
      assertHasKnowledge(state, lineage);
      if (lineage.currentAgentVersionId !== body.expectedAgentVersionId) {
        throw Object.assign(problem(409, 'stale_agent_version', `${receptionistNameOf(lineage)} changed since you opened this. Refresh and try again.`), { currentPointerGeneration: lineage.pointerGeneration, currentAgentVersionId: lineage.currentAgentVersionId });
      }
      const agent = state.agents?.[lineage.currentAgentVersionId];
      const knowledge = agent && state.knowledge?.[agent.knowledgeRevisionId];
      if (!agent || !knowledge || agent.knowledgeRevisionId !== knowledge.id || unavailableVersionIds(lineage).has(lineage.currentAgentVersionId)) throw problem(503, 'agent_not_ready', `${receptionistNameOf(lineage)} is not ready to test.`);
      const reservation = (await tx.query('SELECT * FROM reserve_voice_start_claimed($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10)',
        [actor.scopeId, actor.stableAgentId, 'owner_test', null, config.dailyCapCents, config.reservedCents, config.globalConcurrent, config.reservationTtlSeconds, Math.min(config.scopeDailyMax, OWNER_TEST_DAILY_MAX), config.agentActiveMax])).rows[0];
      if (!reservation.approved) {
        // The database gives one reason for the owner's daily allowance and for Frontline's own budget; the owner needs to know which.
        const denied = reservation.reason === 'voice_limit_reached' && testsToday(state, now) >= OWNER_TEST_DAILY_MAX ? 'test_limit_reached' : reservation.reason;
        throw Object.assign(new Error('voice_reservation_denied'), { denied });
      }
      const record = {
        receptionistName: receptionistNameOf(lineage),
        id: demoId, workspaceId: actor.scopeId, preparationId: null, preparationRevision: null, mode: 'owner_test', callArchitectureVersion: config.callArchitectureVersion,
        stableAgentId: actor.stableAgentId, agentVersionId: lineage.currentAgentVersionId, knowledgeRevisionId: agent.knowledgeRevisionId,
        roomName: `frontline-demo-${demoId}`, generation: 1, reservationId: reservation.reservation_id, state: 'dispatching', stateRevision: 1,
        reconnectAllowed: true, terminalReason: null, createdAt: now.toISOString(), setupDeadlineAt: new Date(now.getTime() + 20_000).toISOString(),
        expiresAt: new Date(now.getTime() + OWNER_TEST_RETENTION_DAYS * 86_400_000).toISOString(), startedAt: null, softCloseAt: null, hardEndAt: null,
      };
      await insertDemo(tx, actor.scopeId, record);
      return record;
    });
  } catch (error) {
    if (error?.denied) { const [status, code, message] = DENIED[error.denied]?.(actor.receptionistName ?? DEFAULT_RECEPTIONIST_NAME) ?? [503, 'voice_unavailable', 'Test calls are not available right now. Please contact the Frontline team.']; throw problem(status, code, message); }
    throw mapDatabaseError(error);
  }
  const credentials = await dispatchVoice({ db, scopeId: actor.scopeId, demo, voice, failureMessage: `${actor.receptionistName ?? DEFAULT_RECEPTIONIST_NAME} can't take a test call right now.` });
  return { ...credentials, agentVersionId: demo.agentVersionId, mode: 'owner_test' };
}

const ownerTestDemo = async (db, actor, demoId) => {
  const demo = await readDemo(db, actor.scopeId, demoId);
  if (!demo || demo.mode !== 'owner_test' || demo.stableAgentId !== actor.stableAgentId) throw problem(404, 'not_found', 'Not found.');
  return demo;
};

/** PO-E14 result. The owner sees the summary and what Bob saved during the test. */
export async function ownerTestResult({ db, actor, demoId }) {
  await ownerTestDemo(db, actor, demoId);
  return withOwnerState(db, actor.scopeId, (state) => {
    const demo = state.demos[demoId];
    const lineage = readLineage(state, actor.stableAgentId);
    return { result: {
      demoId: demo.id, state: demo.state, mode: demo.mode, agentVersionId: demo.agentVersionId, versionNumber: lineage ? versionNumbers(lineage)[demo.agentVersionId] ?? null : null,
      closingPolicy: 'test_summary', setupDeadlineAt: demo.setupDeadlineAt, startedAt: demo.startedAt, softCloseAt: demo.softCloseAt, hardEndAt: demo.hardEndAt,
      terminalReason: demo.terminalReason ?? null, reconnectAllowed: demo.reconnectAllowed ?? !['ending', 'terminal', 'ended'].includes(demo.state), expiresAt: demo.expiresAt,
      requests: withNextSteps(state.outcomes?.[demo.id]), cases: withNextSteps(state.cases?.[demo.id]), callSummary: buildCallSummary(state, demo),
    } };
  });
}

/**
 * Records that a version was tested: the test ended and the owner spoke at least one finalized turn.
 * Connection calls this from the terminal path too (PO-C1), so a hard end also counts. Safe to repeat.
 */
export function markOwnerTestCompleted({ db, scopeId, stableAgentId, demoId, now = new Date() }) {
  return withOwnerState(db, scopeId, (raw) => {
    const demo = raw.demos?.[demoId];
    if (!demo || demo.mode !== 'owner_test' || demo.stableAgentId !== stableAgentId) return { result: false };
    const spoke = (raw.callerTurns?.[demoId] ?? []).some((turn) => turn?.finalized === true);
    if (!spoke) return { result: false };
    const state = ensureLineage(raw, stableAgentId);
    const lineage = readLineage(state, stableAgentId);
    const revisions = lineage.revisions.map((revision) => (revision.agentVersionId === demo.agentVersionId && !revision.lastTestedAt ? { ...revision, lastTestedAt: now.toISOString() } : revision));
    return { result: true, state: { ...state, agentLineages: { ...state.agentLineages, [stableAgentId]: { ...lineage, revisions } } } };
  });
}

/** PO-E14 end. `endOwnerDemo` is the existing terminal path (connection PO-C1). */
export async function endOwnerTest({ db, actor, demoId, endOwnerDemo, now = new Date() }) {
  await ownerTestDemo(db, actor, demoId);
  if (typeof endOwnerDemo !== 'function') throw problem(503, 'voice_unavailable', 'Test calls are not available right now.');
  const ended = await endOwnerDemo({ scopeId: actor.scopeId, demoId });
  await markOwnerTestCompleted({ db, scopeId: actor.scopeId, stableAgentId: actor.stableAgentId, demoId, now });
  return ended;
}
