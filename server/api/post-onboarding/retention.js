import { withOwnerState } from './owner-state.js';

// Removes finished conversations past their retention date from an owner's scope (PO-OQ5: 30 days),
// with everything stored about them. Run by the retention worker after the SQL cleanup (connection PO-C11).

/**
 * Returns the state without the expired, finished demos and their per-demo records, or the same object
 * when there is nothing to remove. A demo that is not finished is never removed here: a live room must
 * end through the terminal path first.
 */
export function pruneExpiredDemos(state, now = new Date()) {
  const expired = Object.values(state.demos ?? {}).filter((demo) => demo?.expiresAt && Date.parse(demo.expiresAt) <= now.getTime() && ['ended', 'failed'].includes(demo.state));
  if (!expired.length) return { state, removed: 0 };
  return { state: removeDemoRecords(state, new Set(expired.map((demo) => demo.id))), removed: expired.length };
}

/**
 * The state without the given demos and everything stored about them: the demo, its requests, workflows, caller turns,
 * outcomes, cases, transcripts, recaps, lookups and the receipts of its workflow instances. Deleting a receptionist uses it too.
 */
export function removeDemoRecords(state, ids) {
  const instanceIds = new Set([...ids].map((id) => state.workflows?.[id]?.workflowInstanceId).filter(Boolean));
  const without = (map) => (map ? Object.fromEntries(Object.entries(map).filter(([id]) => !ids.has(id))) : map);
  const next = { ...state };
  for (const key of ['demos', 'requests', 'workflows', 'callerTurns', 'outcomes', 'cases', 'transcripts', 'recaps']) if (state[key]) next[key] = without(state[key]);
  if (state.lookups) next.lookups = Object.fromEntries(Object.entries(state.lookups).filter(([, item]) => !ids.has(item?.outcome?.demoId)));
  if (state.receipts) next.receipts = Object.fromEntries(Object.entries(state.receipts).filter(([, item]) => !instanceIds.has(item?.workflowInstanceId)));
  return next;
}

/** One sweep. Returns counts only. */
export async function sweepExpiredConversations({ db, limit = 50, now = new Date() }) {
  const { rows } = await db.query('SELECT list_scopes_with_expired_post_onboarding_demos($1::integer) AS scope_id', [limit]);
  let scopes = 0; let conversations = 0;
  for (const { scope_id: scopeId } of rows) {
    const removed = await withOwnerState(db, scopeId, (state) => {
      const pruned = pruneExpiredDemos(state, now);
      return pruned.removed ? { result: pruned.removed, state: pruned.state } : { result: 0 };
    });
    if (removed) { scopes += 1; conversations += removed; }
  }
  return { scopes, conversations };
}
