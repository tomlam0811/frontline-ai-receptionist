import { problem } from './errors.js';
import { assertHasKnowledge, ensureLineage, isPaused, lineageStatus, readLineage } from './lineage.js';
import { withOwnerState } from './owner-state.js';
import { listShares, revokeShare } from './share.js';
import { isCallLive } from './source-redaction.js';

// Pause and resume one receptionist (MR-D5, MR-J4). The status lives on the lineage in the owner scope JSON.
// Pause is two steps: set the status in one transaction (so every new start is refused from then on), then
// clear what is already running. The second step can be repeated, so a pause that failed halfway is finished
// by asking again.

const OPEN_LINK_STATUSES = new Set(['unused', 'reserved', 'active']);
const CALL_MODES = new Set(['owner_test', 'shared_guest']);
const REVOKE_ROUNDS = 3;

const saveStatus = (state, stableAgentId, lineage, status) => ({ ...state, agentLineages: { ...state.agentLineages, [stableAgentId]: { ...lineage, status } } });

/** Revokes every unused, reserved or active link of this receptionist through the existing revoke path. Returns how many were revoked. */
export async function revokeOpenLinks({ db, actor, endLiveCall }) {
  let revoked = 0;
  // A link can change between the list and the revoke (a guest opens it). The next round sees the new version.
  for (let round = 0; round < REVOKE_ROUNDS; round += 1) {
    const { shares } = await listShares({ db, actor });
    const open = shares.filter((share) => OPEN_LINK_STATUSES.has(share.status));
    if (!open.length) return revoked;
    for (const share of open) {
      try {
        await revokeShare({ db, actor, shareId: share.shareId, expectedVersion: share.version, endLiveCall });
        revoked += 1;
      } catch (error) {
        if (error?.code !== 'stale_share') throw error;
      }
    }
  }
  return revoked;
}

/** Ends every call still live for this receptionist (owner tests and shared conversations) through the terminal path. `reason` is recorded by the terminal path. */
export async function endLiveCalls({ db, actor, endLiveCall, reason = 'agent_paused' }) {
  if (typeof endLiveCall !== 'function') return 0;
  const live = await withOwnerState(db, actor.scopeId, (state) => ({
    result: Object.values(state.demos ?? {}).filter((demo) => demo?.stableAgentId === actor.stableAgentId && CALL_MODES.has(demo.mode) && isCallLive(demo)),
  }));
  for (const demo of live) await endLiveCall({ scopeId: actor.scopeId, demoId: demo.id, sessionId: demo.guestSessionId ?? null, reservationId: demo.reservationId ?? null, reason });
  return live.length;
}

/** POST /v1/agents/:id/pause. Safe to repeat: a second pause changes nothing and finishes any cleanup that was left. */
export async function pauseReceptionist({ db, actor, endLiveCall }) {
  await withOwnerState(db, actor.scopeId, (raw) => {
    const state = ensureLineage(raw, actor.stableAgentId);
    const lineage = state && readLineage(state, actor.stableAgentId);
    if (!lineage || lineageStatus(lineage) === 'deleting') throw problem(404, 'not_found', 'Not found.');
    if (isPaused(lineage)) return { result: null };
    return { result: null, state: saveStatus(state, actor.stableAgentId, lineage, 'paused') };
  });
  const linksRevoked = await revokeOpenLinks({ db, actor, endLiveCall });
  await endLiveCalls({ db, actor, endLiveCall });
  return { stableAgentId: actor.stableAgentId, status: 'paused', linksRevoked };
}

/** POST /v1/agents/:id/resume. Links revoked by the pause stay revoked. Safe to repeat. */
export function resumeReceptionist({ db, actor }) {
  return withOwnerState(db, actor.scopeId, (raw) => {
    const state = ensureLineage(raw, actor.stableAgentId);
    const lineage = state && readLineage(state, actor.stableAgentId);
    if (!lineage || lineageStatus(lineage) === 'deleting') throw problem(404, 'not_found', 'Not found.');
    if (!isPaused(lineage)) return { result: { stableAgentId: actor.stableAgentId, status: 'active' } };
    assertHasKnowledge(state, lineage);
    return { result: { stableAgentId: actor.stableAgentId, status: 'active' }, state: saveStatus(state, actor.stableAgentId, lineage, 'active') };
  });
}
