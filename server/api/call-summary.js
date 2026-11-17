// A bounded projection of the caller's persisted evidence. It makes no claim
// about Bob's replies or whether a task succeeded without a saved record.
// Task statuses (voice agent v2): running, succeeded (saved, or the lookup ran), stopped (the caller backed out or
// the call ended first) and failed. Older calls may still carry the retired readback statuses.
const MAX_EXCERPTS = 3;
const MAX_TASKS = 10;
const MAX_TEXT = 160;
const FIELD_KEYS = ['callerName', 'contactPhone', 'contactEmail', 'serviceNeed', 'propertyCity', 'propertyState', 'summary',
  'appointmentAction', 'propertyType', 'company', 'preferredDay', 'preferredWindow', 'timezone', 'recurrence', 'notes'];

const shortText = (value) => {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_TEXT ? `${cleaned.slice(0, MAX_TEXT - 1).trimEnd()}…` : cleaned;
};

function callerExcerpts(turns, workflow) {
  const distinct = [];
  const seen = new Set();
  const evidenceIds = new Set([...Object.values(workflow?.priorTasks ?? {}), workflow?.currentTask]
    .filter(Boolean).flatMap((task) => (task.evidenceTurns ?? []).map((item) => item.callerTurnId)));
  for (const turn of turns) {
    if (turn?.finalized !== true) continue;
    const excerpt = shortText(turn.text);
    if (excerpt.length < 9 || /^(yes|yep|yeah|no|correct|right|okay|ok|sure|thanks|thank you|bye|goodbye)[.! ,]*$/i.test(excerpt)
      || /^(yes|yep|yeah)[, ]+(that's|that is|those|the|all|everything|sounds|makes)\b/i.test(excerpt)
      || /^(that makes sense|makes sense|sounds good)[.! ,]*$/i.test(excerpt)) continue;
    const key = excerpt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ excerpt, index: distinct.length, score: excerpt.length + (evidenceIds.has(turn.callerTurnId) ? 40 : 0) });
  }
  return distinct.sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_EXCERPTS).sort((a, b) => a.index - b.index).map((item) => item.excerpt);
}

function taskSummary(task, state, demoId) {
  const fields = Object.fromEntries(FIELD_KEYS.flatMap((key) => {
    const value = shortText(task.fields?.[key]);
    return value ? [[key, value]] : [];
  }));
  const receipt = task.receipt && Object.values(state.receipts ?? {}).find((item) => item.receiptId === task.receipt.receiptId);
  const records = [...(state.outcomes?.[demoId] ?? []), ...(state.cases?.[demoId] ?? [])];
  const saved = receipt?.outcome === 'saved' && records.some((record) => record.receiptId === receipt.receiptId && record.recordId === receipt.recordId);
  const lookupRecorded = Boolean(task.lookup && Object.values(state.lookups ?? {}).some((item) => item.outcome?.demoId === demoId && item.result?.lookupId === task.lookup.lookupId));
  // A Needs review note exists for this task: saved on the call or noted when the call ended.
  const noted = Boolean(task.noteRecordId && records.some((record) => record.recordId === task.noteRecordId));
  return { kind: task.kind, goal: shortText(task.goal), status: task.status,
    fields, missingFields: Array.isArray(task.missingFields) ? task.missingFields.filter((key) => FIELD_KEYS.includes(key)) : [],
    saved, lookupRecorded, noted };
}

export function buildCallSummary(state, demo) {
  const workflow = state.workflows?.[demo.id];
  const turns = state.callerTurns?.[demo.id] ?? [];
  const tasks = [...Object.values(workflow?.priorTasks ?? {}), workflow?.currentTask]
    .filter(Boolean).slice(-MAX_TASKS).map((task) => taskSummary(task, state, demo.id));
  return { demoId: demo.id, mode: demo.mode, endedAt: demo.endedAt ?? null,
    callerTurnCount: turns.filter((turn) => turn?.finalized === true).length,
    callerExcerpts: callerExcerpts(turns, workflow), tasks };
}
