import { inOwnerScope } from './database.js';
import { problem } from './errors.js';
import { parseCookies, sha256 } from './http.js';
import { businessNameFor, knownVersionIds, lineageStatus, needsKnowledge, readKnowledgeBase, readLineage, versionNumbers } from './lineage.js';
import { ownsUpdate } from './knowledge-selection.js';
import { withOwnerState } from './owner-state.js';
import { receptionistNameOf } from './receptionist-name.js';
import { unavailableVersionIds } from './source-redaction.js';

// The signed-in owner's view of their Bob: the home list (PO-E1), the agent summary the Bob screen
// needs, and the one-time first-visit record (PO-A1). Reads only; the first-visit write is one small field.

const OPEN_UPDATES = ['extracting', 'needs_confirmation', 'applying'];

/** The facts every owner screen needs about one agent, from its scope state. `voiceConfigured` comes from the caller. */
export function summarizeAgent(state, stableAgentId, { voiceConfigured = false } = {}) {
  const lineage = readLineage(state, stableAgentId);
  if (!lineage) return null;
  const agent = state.agents?.[lineage.currentAgentVersionId];
  const ready = Boolean(agent && state.knowledge?.[agent.knowledgeRevisionId]) && !unavailableVersionIds(lineage).has(lineage.currentAgentVersionId);
  const current = lineage.revisions.find((revision) => revision.agentVersionId === lineage.currentAgentVersionId);
  const numbers = versionNumbers(lineage);
  const base = readKnowledgeBase(state, stableAgentId);
  const processing = Object.values(base.updates).some((update) => OPEN_UPDATES.includes(update.state) && ownsUpdate(lineage, update));
  const testedAt = lineage.revisions.map((revision) => revision.lastTestedAt).filter(Boolean).sort().at(-1) ?? null;
  const untestedChanges = lineage.revisions.length > 1 && !current?.lastTestedAt;
  return {
    stableAgentId, kind: 'agent', name: receptionistNameOf(lineage), status: lineageStatus(lineage), needsKnowledge: needsKnowledge(lineage), businessName: businessNameFor(state, stableAgentId), currentAgentVersionId: lineage.currentAgentVersionId,
    versionNumber: numbers[lineage.currentAgentVersionId] ?? 1, pointerGeneration: lineage.pointerGeneration,
    knowledgeState: !ready ? 'unavailable' : processing ? 'processing' : untestedChanges ? 'untested_changes' : 'ready',
    lastTestedAt: testedAt, currentVersionTestedAt: current?.lastTestedAt ?? null, ownerReviewedAt: current?.ownerReviewedAt ?? null, untestedChanges,
    ready, voiceAvailable: Boolean(voiceConfigured),
    firstVisit: { seen: Boolean(state.firstVisit?.[stableAgentId]), outcome: state.firstVisit?.[stableAgentId]?.outcome ?? null },
  };
}

/** PO-E1. One entry per claimed target of the signed-in person. */
export async function listMyAgents({ db, request, voiceConfigured }) {
  const cookie = parseCookies(request).fl_auth;
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) throw problem(401, 'sign_in_required', 'Sign in again to continue.');
  const targets = (await db.query('SELECT * FROM list_frontline_claimed_targets($1)', [sha256(cookie)])).rows;
  // No targets can also mean the session ended (sign-out elsewhere, expiry, account deletion). That browser should sign in again.
  if (!targets.length && !(await db.query('SELECT frontline_session_subject_ref($1) AS ref', [sha256(cookie)])).rows[0]?.ref) throw problem(401, 'sign_in_required', 'Sign in again to continue.');
  const agents = [];
  for (const target of targets) {
    const state = await inOwnerScope(db, target.owner_scope_id, async (tx) => (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [target.owner_scope_id])).rows[0]?.state ?? null);
    if (!state) continue;
    if (target.target_kind === 'agent') {
      const summary = summarizeAgent(state, target.target_id, { voiceConfigured });
      if (summary) agents.push(summary);
    } else {
      agents.push({ stableAgentId: target.target_id, kind: 'workspace', businessName: state.workspaces?.[target.target_id]?.businessName ?? null, currentAgentVersionId: null, knowledgeState: 'unavailable', lastTestedAt: null, ownerReviewedAt: null, untestedChanges: false });
    }
  }
  return { agents };
}

/** GET /v1/agents/:id/summary (a scaffold addition, see the technical spec deviations). */
export function getAgentSummary({ db, actor, voiceConfigured }) {
  return withOwnerState(db, actor.scopeId, (state) => {
    const summary = summarizeAgent(state, actor.stableAgentId, { voiceConfigured });
    if (!summary) throw problem(404, 'not_found', 'Not found.');
    return { result: { ...summary, knownVersionIds: knownVersionIds(readLineage(state, actor.stableAgentId)) } };
  });
}

/** POST /v1/agents/:id/first-visit. Records that the prompt was dismissed or continued; never a rating. */
export function recordFirstVisit({ db, actor, body, now = new Date() }) {
  if (!['skipped', 'continued'].includes(body?.outcome)) throw problem(400, 'invalid_field', 'outcome: use skipped or continued.');
  return withOwnerState(db, actor.scopeId, (state) => {
    if (state.firstVisit?.[actor.stableAgentId]) return { result: { seen: true, outcome: state.firstVisit[actor.stableAgentId].outcome } };
    return { result: { seen: true, outcome: body.outcome }, state: { ...state, firstVisit: { ...state.firstVisit, [actor.stableAgentId]: { outcome: body.outcome, at: now.toISOString() } } } };
  });
}
