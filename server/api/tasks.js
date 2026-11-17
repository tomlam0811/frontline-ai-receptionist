import { randomUUID } from 'node:crypto';
import { validateContract, validateReceipt } from '../../contracts/v1/contract-validator.js';
import { problem } from './contracts.js';
import { buildTaskRecord, missingFieldsFor, normalizeField, storeTaskRecord, updateTaskRecord } from './task-records.js';
import { assertWorkflowEnabled, beginEnding, ensureWorkflow, payloadHash } from './workflows.js';

// Task commands for the bob-task-v1 architecture as revised by voice agent v2 (VA-C1). The conversation model
// records what it hears through `record`; the backend validates each field, holds the draft, and saves a service
// request in the same call that completes it. Nothing here waits for a readback or a confirmation.
const VERSION = 'bob-task-v1';
const MAX_RECORD_FIELDS = 20;
// The workflow each task kind belongs to. A version that turned the workflow off cannot start the task.
const TASK_WORKFLOWS = Object.freeze({ service_request: 'WF-03', appointment_lookup: 'WF-04', complaint: 'WF-05' });
// Modes that speak for a business. Owner test calls and shared guest calls use the same tasks as the onboarding demo.
const BUSINESS_MODES = new Set(['business_demo', 'owner_test', 'shared_guest']);
const PUBLIC_KEYS = ['taskId', 'kind', 'status', 'callerTurnId', 'originTurnId', 'sessionId', 'agentVersionId', 'knowledgeRevisionId',
  'goal', 'fields', 'missingFields', 'evidenceTurns', 'receipt', 'lookup', 'noteRecordId', 'lastOperationId'];
const PUBLIC_DEFAULTS = Object.freeze({ fields: {}, missingFields: [], evidenceTurns: [] });
const nowIso = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
export const publicTask = (task) => clone(Object.fromEntries(PUBLIC_KEYS.map((key) => [key, task[key] ?? PUBLIC_DEFAULTS[key] ?? null])));
const responseFor = (task, revision) => ({ task: publicTask(task), workflowRevision: revision });
const reject = (code, message, workflow, status = 409) => Object.assign(problem(status, code, message), { currentWorkflowRevision: workflow.revision });

function checkVersion(demo, businessOnly = true) {
  if (demo.callArchitectureVersion !== VERSION) throw problem(409, 'unsupported_call_architecture', 'Task API requires bob-task-v1.');
  if (businessOnly && !BUSINESS_MODES.has(demo.mode)) throw problem(403, 'wrong_mode', 'Business tasks are unavailable in Frontline Q&A mode.');
}

/** Any finalized caller turn of this call. Task commands no longer need the latest one. */
function callerTurn(state, demo, id, workflow) {
  const turn = (state.callerTurns?.[demo.id] ?? []).find((item) => item.callerTurnId === id && item.finalized === true);
  if (!turn) throw reject('unknown_caller_turn', 'Use a finalized caller turn from this call.', workflow);
  return turn;
}

function latestTurn(state, demo, id) {
  const latest = state.callerTurns?.[demo.id]?.at(-1);
  if (!latest || latest.callerTurnId !== id || latest.finalized !== true) throw problem(409, 'stale_caller_turn', 'Task input must use the latest finalized caller turn.');
  return latest;
}

const evidence = ({ callerTurnId, sequence, text }) => ({ callerTurnId, sequence, text });
function initialEvidence(state, demo, current, originTurn) {
  const turns = state.callerTurns?.[demo.id] ?? [];
  const previous = current && turns.find((item) => item.callerTurnId === current.callerTurnId);
  // Preserve the caller's lead-in before assent delegated the task, without
  // importing details from an earlier task or another session.
  const lead = turns.filter((item) => item.finalized === true && item.demoId === demo.id
    && item.sequence <= originTurn.sequence && item.sequence > (previous?.sequence ?? 0)).slice(-12).map(evidence);
  return lead.length ? lead : [evidence(originTurn)];
}

function addEvidence(task, turn) {
  if (!task.evidenceTurns.some((item) => item.callerTurnId === turn.callerTurnId)) task.evidenceTurns = [...task.evidenceTurns, evidence(turn)].slice(-100);
  task.callerTurnId = turn.callerTurnId;
}

function assertOpen(demo, workflow) {
  if (demo.state !== 'active' || ['ending', 'terminal'].includes(workflow.phase)) throw reject('session_ending', 'This session no longer accepts task changes.', workflow);
}

const taskById = (workflow, id) => (workflow.currentTask?.taskId === id ? workflow.currentTask : workflow.priorTasks?.[id]);

function receipt(state, workflow, operationId, kind, record) {
  workflow.revision += 1;
  const value = validateReceipt({ receiptId: randomUUID(), operationId, operationKind: kind,
    payloadHash: payloadHash({ operationId, kind, record }), workflowInstanceId: workflow.workflowInstanceId,
    workflowRevision: workflow.revision, recordedAt: nowIso(), sequence: Object.keys(state.receipts ?? {}).length + 1,
    outcome: 'saved', recordId: record.recordId });
  record.receiptId = value.receiptId;
  (state.receipts ??= {})[operationId] = value;
  return value;
}

/** Saves the task as a receipted record (a request, or a complaint case) and marks it succeeded. */
function saveWithReceipt(state, demo, workflow, task, operationId) {
  const record = buildTaskRecord(state, demo, workflow, task);
  task.receipt = receipt(state, workflow, operationId, task.kind === 'complaint' ? 'case' : 'request', record);
  storeTaskRecord(state, demo, task, record);
  task.status = 'succeeded';
}

function startTask(state, demo, workflow, input) {
  const goal = input.goal.trim();
  if (!goal) throw problem(400, 'invalid_task_command', 'Task goal must contain words.');
  const existing = taskById(workflow, input.taskId);
  if (existing) {
    if (existing.kind !== input.kind || existing.goal !== goal) throw reject('task_conflict', 'Task identifier was reused with different input.', workflow);
    return responseFor(existing, workflow.revision);
  }
  assertWorkflowEnabled(state, demo, TASK_WORKFLOWS[input.kind]);
  const current = workflow.currentTask;
  if (current?.status === 'running') {
    // A second start of the same kind returns the open task, so a retried or repeated start never loses the draft.
    if (current.kind === input.kind) return responseFor(current, workflow.revision);
    throw reject('task_already_active', 'Finish or cancel the current task first.', workflow);
  }
  assertOpen(demo, workflow);
  const turn = callerTurn(state, demo, input.callerTurnId, workflow);
  if (current) (workflow.priorTasks ??= {})[current.taskId] = current;
  workflow.currentTask = { taskId: input.taskId, kind: input.kind, status: 'running', callerTurnId: turn.callerTurnId,
    originTurnId: turn.callerTurnId, sessionId: demo.id, agentVersionId: demo.agentVersionId, knowledgeRevisionId: demo.knowledgeRevisionId,
    goal, fields: {}, missingFields: missingFieldsFor(input.kind, {}), evidenceTurns: initialEvidence(state, demo, current, turn),
    receipt: null, lookup: null, noteRecordId: null, lastOperationId: null, createdAt: nowIso(), operationResults: {} };
  workflow.revision += 1;
  return responseFor(workflow.currentTask, workflow.revision);
}

// A saved service request stays open to changes until the call ends: the caller can correct the city, add the exact
// address or give a better number. assertOpen refuses every change once the call is ending, which locks it.
const isEditable = (task) => task.kind === 'service_request' && task.status === 'succeeded' && Boolean(task.receipt);

function recordFields(state, demo, workflow, task, input, turn) {
  if (task.status !== 'running' && !isEditable(task)) throw reject('task_not_running', 'This task is stopped or complete.', workflow);
  const entries = Object.entries(input.fields);
  if (entries.length > MAX_RECORD_FIELDS) throw problem(400, 'invalid_task_command', 'Too many fields in one record.');
  /** @type {Record<string, any>} */ const accepted = {}; /** @type {Record<string, string>} */ const rejected = {};
  const phoneAsGiven = input.fields.phoneAsGiven === true;
  for (const [key, value] of entries) {
    const result = normalizeField(key, value, { phoneAsGiven });
    if ('reason' in result) rejected[key] = result.reason; else accepted[key] = result.value;
  }
  addEvidence(task, turn);
  if (!Object.keys(accepted).length) return { accepted, rejected };
  const fields = { ...task.fields };
  // A different city voids the state and confirmation recorded for the old one.
  if (fields.propertyCity && typeof accepted.propertyCity === 'string' && accepted.propertyCity.toLowerCase() !== fields.propertyCity.toLowerCase()) {
    if (!('propertyState' in accepted)) delete fields.propertyState;
    if (!('cityConfirmed' in accepted)) delete fields.cityConfirmed;
  }
  // A different number voids the confirmation of the old one, so the new number is read back too.
  if (fields.contactPhone && typeof accepted.contactPhone === 'string' && accepted.contactPhone !== fields.contactPhone && !('phoneConfirmed' in accepted)) {
    delete fields.phoneConfirmed;
  }
  task.fields = Object.assign(fields, accepted);
  task.missingFields = missingFieldsFor(task.kind, task.fields);
  workflow.revision += 1;
  // A change to a saved request updates the record the owner sees. A new number it brings is read back again, and
  // until then the record lists the confirmation as missing.
  if (isEditable(task)) updateTaskRecord(state, demo, task);
  // VA-D7: the record that completes a service request saves it, so there is no separate save turn.
  else if (task.kind === 'service_request' && !task.missingFields.length) saveWithReceipt(state, demo, workflow, task, input.operationId);
  return { accepted, rejected };
}

function finishTask(state, demo, workflow, task, input, turn, options) {
  if (task.status !== 'running') throw reject('task_not_running', 'This task is stopped or complete.', workflow);
  if (task.kind === 'service_request') throw reject('finish_not_allowed', 'A service request saves when its details are complete.', workflow);
  if (task.kind === 'complaint' && !task.fields.summary) throw reject('task_incomplete', 'Record what the complaint is about first.', workflow);
  if (task.kind === 'appointment_lookup' && (!task.fields.callerName || !task.fields.appointmentAction)) {
    throw reject('task_incomplete', 'Record the caller name and whether to cancel or reschedule first.', workflow);
  }
  addEvidence(task, turn);
  task.missingFields = missingFieldsFor(task.kind, task.fields);
  if (task.kind === 'complaint') { saveWithReceipt(state, demo, workflow, task, input.operationId); return; }
  workflow.revision += 1;
  const failureReason = options.lookupFailureReason?.();
  const result = failureReason ? { kind: 'unavailable', lookupId: randomUUID(), reason: failureReason, workflowRevision: workflow.revision }
    : { kind: 'not_found', lookupId: randomUUID(), workflowRevision: workflow.revision };
  const action = task.fields.appointmentAction;
  state.lookups[input.operationId] = { payloadHash: payloadHash({ operationId: input.operationId, taskId: task.taskId, callerName: task.fields.callerName, action }), result,
    outcome: { demoId: demo.id, workflowInstanceId: workflow.workflowInstanceId, action, result, recordedAt: nowIso() } };
  task.lookup = result;
  // No appointment can be changed on the call today, so the lookup is also a Needs review note (VA-D4).
  storeTaskRecord(state, demo, task, buildTaskRecord(state, demo, workflow, task, { lookup: result }));
  task.status = 'succeeded';
}

function cancelTask(workflow, task) {
  // The caller backed out. The fields stay, and the call's terminal path turns them into a Needs review note.
  if (task.status === 'running') { task.status = 'stopped'; workflow.revision += 1; }
}

export function taskCommand(state, demo, input, options = {}) {
  try { validateContract('task.schema.json#/$defs/command', input); }
  catch { throw problem(400, 'invalid_task_command', 'Task command does not match the task contract.'); }
  checkVersion(demo);
  const workflow = ensureWorkflow(state, demo);
  if (input.action === 'start') return startTask(state, demo, workflow, input);
  // record, finish and cancel carry an operationId: a repeat replays its first result, a changed payload conflicts.
  const hash = payloadHash(input);
  const seen = workflow.taskOperationIndex?.[input.operationId];
  if (seen) {
    if (seen.hash !== hash) throw reject('operation_conflict', 'Operation identifier was used with a different command.', workflow);
    const old = taskById(workflow, seen.taskId)?.operationResults?.[input.operationId];
    if (old) return clone(old.response);
  }
  const task = taskById(workflow, input.taskId);
  if (!task) throw reject('task_not_found', 'Task is unavailable for this session.', workflow);
  assertOpen(demo, workflow);
  const turn = callerTurn(state, demo, input.callerTurnId, workflow);
  let extra = {};
  if (input.action === 'record') extra = recordFields(state, demo, workflow, task, input, turn);
  else if (input.action === 'finish') finishTask(state, demo, workflow, task, input, turn, options);
  else cancelTask(workflow, task);
  task.lastOperationId = input.operationId;
  const response = { ...responseFor(task, workflow.revision), ...extra };
  (task.operationResults ??= {})[input.operationId] = { hash, response };
  (workflow.taskOperationIndex ??= {})[input.operationId] = { taskId: task.taskId, hash };
  return clone(response);
}

export function taskEnd(state, demo, input) {
  try { validateContract('task.schema.json#/$defs/endInput', input); }
  catch { throw problem(400, 'invalid_task_end', 'Task ending command does not match the contract.'); }
  checkVersion(demo, false);
  const workflow = ensureWorkflow(state, demo);
  if (workflow.taskEndCommand?.callerTurnId === input.callerTurnId && workflow.taskEndCommand.reason === input.reason) return workflow.taskEndCommand.result;
  if (demo.state !== 'active' || workflow.revision !== input.expectedWorkflowRevision || demo.stateRevision !== input.expectedStateRevision) {
    throw Object.assign(problem(409, 'stale_task_end', 'Session or task state changed.'), { currentWorkflowRevision: workflow.revision, currentStateRevision: demo.stateRevision });
  }
  latestTurn(state, demo, input.callerTurnId);
  // beginEnding turns every unfinished task into a Needs review note with this reason.
  const result = beginEnding(state, demo, { expectedStateRevision: input.expectedStateRevision, reason: input.reason });
  workflow.taskEndEvidence = { callerTurnId: input.callerTurnId, reason: input.reason };
  workflow.taskEndCommand = { callerTurnId: input.callerTurnId, reason: input.reason, result };
  return result;
}
