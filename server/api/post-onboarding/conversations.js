import { problem } from './errors.js';
import { knownVersionIds, readLineage, receptionistNameFor, versionNumbers } from './lineage.js';
import { withOwnerState } from './owner-state.js';
import { buildCallSummary } from '../call-summary.js';
import { withNextStep, withNextSteps } from '../next-step.js';

// Conversation history for the owner (technical spec PO-E16, PO-TD13, PO-TD15). A conversation is a demo
// of any version of this agent. The list is a projection. The writes are a call's stored recap and a note's review status.

export const ORIGIN_OF_MODE = { business_demo: 'trial', owner_test: 'owner_test', shared_guest: 'shared' };
export const TRANSCRIPT_ENTRY_CAP = 200;
const LIMIT_DEFAULT = 25;
const LIMIT_MAX = 100;

const encodeCursor = (demo) => Buffer.from(`${demo.createdAt}|${demo.id}`).toString('base64url');
function decodeCursor(cursor) {
  const [createdAt, id, ...rest] = Buffer.from(String(cursor), 'base64url').toString().split('|');
  if (!createdAt || !id || rest.length || !Number.isFinite(Date.parse(createdAt))) throw problem(400, 'invalid_field', 'cursor: use the value from the previous page.');
  return { createdAt, id };
}

const belongsTo = (demo, stableAgentId, versions) => demo?.mode in ORIGIN_OF_MODE && (demo.stableAgentId === stableAgentId || versions.includes(demo.agentVersionId));
const seconds = (demo) => (demo.startedAt && demo.endedAt ? Math.max(0, Math.round((Date.parse(demo.endedAt) - Date.parse(demo.startedAt)) / 1000)) : null);

/** The display transcript: the caller's finalized turns and Bob's recorded turns in time order (caller first on a tie). */
export function transcriptFor(state, demoId) {
  const caller = (state.callerTurns?.[demoId] ?? []).filter((turn) => turn?.finalized === true).map((turn) => ({ order: 0, entry: { speaker: 'caller', text: turn.text, at: turn.recordedAt } }));
  const bobTurns = state.transcripts?.[demoId] ?? [];
  const bob = bobTurns.map((turn) => ({ order: 1, entry: { speaker: 'bob', text: turn.text, at: turn.at, ...(turn.interrupted === true ? { interrupted: true } : {}) } }));
  const merged = [...caller, ...bob].sort((a, b) => String(a.entry.at).localeCompare(String(b.entry.at)) || a.order - b.order);
  const entries = merged.map((item, index) => ({ seq: index + 1, ...item.entry }));
  const notice = !bobTurns.length ? 'bob_side_not_recorded' : bobTurns.length >= TRANSCRIPT_ENTRY_CAP ? 'partial' : null;
  return { transcript: entries.length ? entries : null, transcriptNotice: notice };
}

/** A request or complaint the call ended before finishing: it was turned into a Needs review note at the end (VA-D4). */
function requestLeftOpen(state, demoId) {
  const workflow = state.workflows?.[demoId];
  return [...Object.values(workflow?.priorTasks ?? {}), workflow?.currentTask].some((task) => Boolean(task?.noteRecordId) && task.status !== 'succeeded');
}

const listItem = (demo, numbers, state) => ({
  conversationId: demo.id, origin: ORIGIN_OF_MODE[demo.mode], startedAt: demo.startedAt ?? demo.createdAt, endedAt: demo.endedAt ?? null, durationSeconds: seconds(demo),
  state: demo.state, terminalReason: demo.terminalReason ?? null, agentVersionId: demo.agentVersionId, versionLabel: numbers[demo.agentVersionId] ? `Version ${numbers[demo.agentVersionId]}` : null,
  hasBobTranscript: (state.transcripts?.[demo.id] ?? []).length > 0, requestLeftOpen: requestLeftOpen(state, demo.id),
});

/** PO-E16 list. Conversations past their retention date are not listed. */
export function listConversations({ db, actor, query = /** @type {{limit?: string, cursor?: string}} */ ({}), now = new Date() }) {
  const limit = query.limit == null || query.limit === '' ? LIMIT_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw problem(400, 'invalid_field', `limit: use 1 to ${LIMIT_MAX}.`);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  return withOwnerState(db, actor.scopeId, (state) => {
    const lineage = readLineage(state, actor.stableAgentId);
    if (!lineage) throw problem(404, 'not_found', 'Not found.');
    const versions = knownVersionIds(lineage);
    const numbers = versionNumbers(lineage);
    const all = Object.values(state.demos ?? {})
      .filter((demo) => belongsTo(demo, actor.stableAgentId, versions) && !(demo.expiresAt && Date.parse(demo.expiresAt) <= now.getTime()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const rest = after ? all.filter((demo) => demo.createdAt < after.createdAt || (demo.createdAt === after.createdAt && demo.id < after.id)) : all;
    const page = rest.slice(0, limit);
    return { result: { conversations: page.map((demo) => listItem(demo, numbers, state)), nextCursor: rest.length > limit ? encodeCursor(page.at(-1)) : null } };
  });
}

/** The owner's conversation in this state. Another owner's id and an unknown id are both 404. */
function ownedConversation(state, actor, conversationId, now) {
  const lineage = readLineage(state, actor.stableAgentId);
  const demo = state.demos?.[conversationId];
  if (!lineage || !belongsTo(demo, actor.stableAgentId, knownVersionIds(lineage))) throw problem(404, 'not_found', 'Not found.');
  if (demo.expiresAt && Date.parse(demo.expiresAt) <= now.getTime()) throw problem(410, 'conversation_expired', 'This conversation was removed after 30 days.');
  return { demo, lineage };
}

const FINISHED = ['ended', 'failed'];

/** The stored recap while it still covers the whole transcript. */
const storedRecap = (state, demoId, entryCount) => {
  const recap = state.recaps?.[demoId];
  return recap && recap.entryCount === entryCount ? recap.text : null;
};

/**
 * PO-E16 detail. Another owner's id and an unknown id are both 404. A finished call without a recap gets one written
 * by the model outside the row lock, then stored, so later views read it. When that fails the recap is null.
 */
export async function getConversation({ db, actor, conversationId, writeRecap = null, now = new Date() }) {
  const read = await withOwnerState(db, actor.scopeId, (state) => {
    const { demo, lineage } = ownedConversation(state, actor, conversationId, now);
    const transcript = transcriptFor(state, demo.id);
    const entryCount = transcript.transcript?.length ?? 0;
    return { result: {
      detail: { ...listItem(demo, versionNumbers(lineage), state), summary: buildCallSummary(state, demo), recap: storedRecap(state, demo.id, entryCount),
        outcomes: { requests: withNextSteps(state.outcomes?.[demo.id]), cases: withNextSteps(state.cases?.[demo.id]) }, ...transcript },
      name: receptionistNameFor(lineage), finished: FINISHED.includes(demo.state), entryCount,
    } };
  });
  const { detail } = read;
  if (detail.recap || !read.finished || !writeRecap || !detail.transcript) return detail;
  let text = null;
  try { text = await writeRecap(detail.transcript, { name: read.name }); } catch { /* The page shows the notes and transcript without it. */ }
  if (!text) return detail;
  await withOwnerState(db, actor.scopeId, (state) => {
    if (!state.demos?.[conversationId]) return { result: null };
    (state.recaps ??= {})[conversationId] = { text, entryCount: read.entryCount, createdAt: now.toISOString() };
    return { result: null, state };
  });
  return { ...detail, recap: text };
}

/**
 * Writes recaps ahead for the newest finished conversations on a list page, so opening one does not wait on the model.
 * A conversation that already has its recap is a plain read.
 */
export async function prepareRecaps({ db, actor, conversations, writeRecap, now = new Date(), limit = 3 }) {
  for (const item of conversations.filter((conversation) => FINISHED.includes(conversation.state)).slice(0, limit)) {
    await getConversation({ db, actor, conversationId: item.conversationId, writeRecap, now });
  }
}

const REVIEW_STATUSES = ['done', 'needs_review'];

/**
 * VA-D13: the owner marks a Needs review note done, or undoes it. Scoped exactly like the conversation read, so
 * another owner's record and an unknown id are both 404. The status is stored on the record, shared by the business.
 */
export function reviewOutcome({ db, actor, conversationId, recordId, body, now = new Date() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'reviewStatus') || !REVIEW_STATUSES.includes(body.reviewStatus)) {
    throw problem(400, 'invalid_field', 'reviewStatus: use done or needs_review.');
  }
  return withOwnerState(db, actor.scopeId, (state) => {
    const { demo } = ownedConversation(state, actor, conversationId, now);
    const record = [...(state.outcomes?.[demo.id] ?? []), ...(state.cases?.[demo.id] ?? [])].find((item) => item?.recordId === recordId);
    if (!record) throw problem(404, 'not_found', 'Not found.');
    record.reviewStatus = body.reviewStatus;
    record.reviewedAt = body.reviewStatus === 'done' ? now.toISOString() : null;
    return { result: { record: withNextStep(record) }, state };
  });
}
