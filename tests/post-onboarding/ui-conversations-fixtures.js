import { randomUUID } from 'node:crypto';
import { asOwner } from './fixtures.js';

// Conversations the way the backend tests make them: a demo record in the owner's scope, plus what the voice
// worker writes while a call runs (finalized caller turns, Blake's turns, saved outcomes). The worker itself is the
// only thing replaced; the list and detail routes that read these records are the real ones.

/**
 * @typedef {object} DemoSeed
 * @property {string} [id]
 * @property {'owner_test'|'shared_guest'|'business_demo'} [mode]
 * @property {string} createdAt ISO time; the list is newest first by this
 * @property {number} [durationSeconds]
 * @property {'ended'|'failed'|'active'} [state]
 * @property {string} [terminalReason]
 * @property {string} [expiresAt] defaults to far in the future
 * @property {Array<{text: string, at?: string}>} [callerTurns]
 * @property {Array<{text: string, at?: string, interrupted?: boolean}>} [bobTurns]
 * @property {any} [currentTask] a workflow task the summary is built from
 * @property {any[]} [requests] saved service requests
 * @property {any[]} [cases] saved complaints and escalations
 * @property {Array<{receiptId: string, recordId: string}>} [receipts] saved-outcome receipts, so a task counts as saved
 */

/** @param {any} pg @param {{scopeId: string, agentId: string}} owner @param {DemoSeed[]} seeds @returns {Promise<string[]>} the demo ids */
export async function seedConversations(pg, owner, seeds) {
  return asOwner(pg, async () => {
    const state = (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
    const ids = [];
    for (const seed of seeds) {
      const id = seed.id ?? randomUUID();
      ids.push(id);
      const startedAt = seed.createdAt;
      const endedAt = seed.durationSeconds == null ? null : new Date(Date.parse(startedAt) + seed.durationSeconds * 1000).toISOString();
      (state.demos ??= {})[id] = { id, mode: seed.mode ?? 'owner_test', stableAgentId: owner.agentId, agentVersionId: owner.agentId, state: seed.state ?? 'ended', terminalReason: seed.terminalReason ?? null, createdAt: seed.createdAt, startedAt, endedAt, expiresAt: seed.expiresAt ?? '2099-01-01T00:00:00.000Z' };
      (seed.callerTurns ?? []).forEach((turn, index) => {
        ((state.callerTurns ??= {})[id] ??= []).push({ callerTurnId: randomUUID(), clientTurnId: randomUUID(), demoId: id, sequence: index + 1, text: turn.text, finalized: true, recordedAt: turn.at ?? new Date(Date.parse(startedAt) + (index + 1) * 2000).toISOString(), workflowRevision: 1 });
      });
      if (seed.bobTurns) {
        (state.transcripts ??= {})[id] = seed.bobTurns.map((turn, index) => ({ seq: index + 1, speaker: 'bob', text: turn.text, at: turn.at ?? new Date(Date.parse(startedAt) + (index + 1) * 2000 + 1000).toISOString(), turnId: randomUUID(), ...(turn.interrupted ? { interrupted: true } : {}) }));
      }
      if (seed.currentTask) (state.workflows ??= {})[id] = { workflowInstanceId: randomUUID(), currentTask: seed.currentTask, priorTasks: {} };
      if (seed.requests) (state.outcomes ??= {})[id] = seed.requests;
      if (seed.cases) (state.cases ??= {})[id] = seed.cases;
      for (const receipt of seed.receipts ?? []) (state.receipts ??= {})[receipt.receiptId] = { ...receipt, outcome: 'saved' };
    }
    await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
    return ids;
  });
}

/** Minutes after noon UTC two days ago, so seeded conversations sort predictably and always fall before a call made now. */
const BASE = (() => { const day = new Date(Date.now() - 2 * 86_400_000); return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 0, 0); })();
export const at = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
