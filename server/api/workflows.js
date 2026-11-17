import { createHash, randomUUID } from 'node:crypto';
import { validateConfirmationBinding, validateContract, validateReceipt, validateTerminalSession, validateWorkflowState } from '../../contracts/v1/contract-validator.js';
import { problem } from './contracts.js';
import { missingFieldsFor, noteOpenTasks } from './task-records.js';

const allowedTools = Object.freeze({
  'WF-01': ['retrieve_facts', 'get_service_details'], 'WF-02': ['list_services', 'get_service_details'],
  'WF-03': ['validate_request', 'save_request'], 'WF-04': ['lookup_appointment'],
  'WF-05': ['save_case'], 'WF-06': ['record_escalation', 'end_session'],
});
export const ALL_WORKFLOW_IDS = Object.freeze(Object.keys(allowedTools));
const clean = (value) => typeof value === 'string' ? value.trim() : value;
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const canonical = (value) => JSON.stringify(ordered(value));
export const payloadHash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const nowIso = () => new Date().toISOString();

export function ensureWorkflow(state, demo) {
  state.workflows ??= {}; state.callerTurns ??= {}; state.outcomes ??= {}; state.cases ??= {}; state.lookups ??= {}; state.receipts ??= {};
  return state.workflows[demo.id] ??= { workflowInstanceId: randomUUID(), workflowId: 'WF-01', phase: 'interpreting', revision: 1, allowedToolIds: demo.mode === 'frontline_qa' ? [] : allowedTools['WF-01'], suspendedWorkflowId: null, suspendedPhase: null, fieldRevision: 0, readbackRevision: 0, fields: {}, currentValidation: null, readback: null, confirmation: null, clarificationCount: 0 };
}

// The workflows a pinned agent version has turned off (PO-C6). The version's capability list is immutable, so the set
// cannot change during a call. WF-01 (answering) and WF-06 (escalation) are always on. A version with no capability
// list, such as every onboarding demo agent today, keeps every workflow on.
const ALWAYS_ENABLED_WORKFLOWS = new Set(['WF-01', 'WF-06']);
export function disabledWorkflowIds(state, demo) {
  const capabilities = state.agents?.[demo.agentVersionId]?.capabilityManifest?.workflowCapabilities;
  if (!Array.isArray(capabilities)) return new Set();
  return new Set(capabilities.filter((item) => item.enabled === false && !ALWAYS_ENABLED_WORKFLOWS.has(item.workflowId)).map((item) => item.workflowId));
}

export function assertWorkflowEnabled(state, demo, workflowId) {
  if (disabledWorkflowIds(state, demo).has(workflowId)) {
    throw Object.assign(problem(409, 'workflow_disabled', 'This capability is turned off for this version of Blake.'), { currentWorkflowRevision: state.workflows?.[demo.id]?.revision ?? 1 });
  }
}

function assertBusinessDemo(demo) {
  if (demo.mode === 'frontline_qa') throw problem(403, 'wrong_mode', 'Business intake is unavailable in Frontline Q&A mode.');
}

export function assertActive(demo, workflow, expected) {
  if (demo.state !== 'active' || ['ending', 'terminal'].includes(workflow.phase)) throw problem(409, 'session_ending', 'This session no longer accepts changes.');
  if (workflow.revision !== expected) throw Object.assign(problem(409, 'stale_workflow', 'Workflow changed. Reload before continuing.'), { currentWorkflowRevision: workflow.revision, currentStateRevision: demo.stateRevision ?? 1 });
}

function assertTool(workflow, workflowId, toolId, phases) {
  if (workflow.workflowId !== workflowId || !workflow.allowedToolIds.includes(toolId) || (phases && !phases.includes(workflow.phase))) {
    throw Object.assign(problem(409, 'workflow_tool_not_allowed', 'This action is not allowed by the current workflow.'), { currentWorkflowRevision: workflow.revision });
  }
}

function assertCaseBinding(state, demo, input, escalation) {
  const turns = state.callerTurns[demo.id] ?? [];
  const ids = new Set(turns.map((turn) => turn.callerTurnId));
  const latest = turns.at(-1);
  if (!latest || !input.context.callerTurnIds.includes(latest.callerTurnId) || input.context.callerTurnIds.some((id) => !ids.has(id))) {
    throw problem(409, 'stale_caller_turn', 'Case context must include the latest finalized caller turn and no other session.');
  }
  const taskEndAuthorized = escalation && demo.callArchitectureVersion === 'bob-task-v1'
    && state.workflows?.[demo.id]?.taskEndEvidence?.callerTurnId === latest.callerTurnId
    && state.workflows?.[demo.id]?.taskEndEvidence?.reason === input.reason;
  if (escalation && (input.reason !== demo.terminalReason || (!taskEndAuthorized && latest.classification?.escalationReason !== input.reason))) {
    throw problem(409, 'stale_escalation', 'Escalation reason is not bound to the ending caller turn.');
  }
  if (!escalation && (latest.classification?.status !== 'classified' || latest.classification?.workflowId !== 'WF-05')) {
    throw problem(409, 'stale_case', 'Complaint context is not bound to the authorized caller turn.');
  }
}

function acceptedEscalation(classification, workflow) {
  if (classification.status !== 'classified' || classification.confidence < 0.65 || classification.workflowId !== 'WF-06') return null;
  if (classification.escalationReason === 'human_preference') return classification.dialogueAct === 'request_human' ? 'human_preference' : null;
  if (['urgency', 'safety_emergency'].includes(classification.escalationReason)) return classification.escalationReason;
  // A blocking unknown is terminal only after the bounded clarification path has
  // already been used. The first uncertain turn remains a request-only fallback.
  if (classification.escalationReason === 'blocking_unknown' && (workflow.phase === 'clarifying' || workflow.clarificationCount > 0)) return 'blocking_unknown';
  return null;
}

function setWorkflow(workflow, workflowId, phase, toolIds = allowedTools[workflowId]) {
  if (workflowId === 'WF-01' && workflow.workflowId !== 'WF-01' && !workflow.suspendedWorkflowId) {
    workflow.suspendedWorkflowId = workflow.workflowId;
    workflow.suspendedPhase = workflow.phase;
  } else if (workflowId !== 'WF-01') {
    workflow.suspendedWorkflowId = null;
    workflow.suspendedPhase = null;
  }
  workflow.workflowId = workflowId; workflow.phase = phase; workflow.allowedToolIds = toolIds; workflow.revision += 1;
  return validateWorkflowState({ workflowInstanceId: workflow.workflowInstanceId, workflowId, phase, revision: workflow.revision, allowedToolIds: workflow.allowedToolIds, suspendedWorkflowId: workflow.suspendedWorkflowId });
}

export async function recordTurn(state, demo, input, classifier, classify = true) {
  validateContract(classify ? 'boundary.schema.json#/$defs/turnInput' : 'boundary.schema.json#/$defs/callerTurnInput', input);
  const workflow = ensureWorkflow(state, demo);
  const turns = state.callerTurns[demo.id] ??= [];
  const replay = turns.find((item) => item.clientTurnId === input.clientTurnId);
  if (replay) {
    if (replay.text !== input.text.trim()) throw problem(409, 'turn_conflict', 'This turn identifier was already used.');
    if (!classify) return Object.fromEntries(Object.entries(replay).filter(([key]) => !['classification', 'decision'].includes(key)));
    return replay.decision;
  }
  if (classify) assertActive(demo, workflow, input.expectedWorkflowRevision);
  else if (demo.state !== 'active' || ['ending', 'terminal'].includes(workflow.phase)) throw problem(409, 'session_ending', 'This session no longer accepts changes.');
  const turn = { callerTurnId: randomUUID(), clientTurnId: input.clientTurnId, demoId: demo.id, sequence: turns.length + 1, text: input.text.trim(), finalized: true, recordedAt: nowIso(), workflowRevision: workflow.revision };
  turns.push(turn);
  if (!classify) return turn;
  const publicTurn = { ...turn };
  let classification;
  try {
    // Jev receives bounded, non-verbatim dialogue metadata in addition to the
    // authoritative workflow snapshot. This is enough to interpret a bare
    // affirmation or field fragment without forwarding earlier caller PII.
    classification = await classifier(turn.text, {
      demo,
      workflow: { ...workflow },
      recentCallerTurns: turns.slice(-4, -1).map((item) => ({
        sequence: item.sequence,
        workflowId: item.classification?.workflowId ?? null,
        dialogueAct: item.classification?.dialogueAct ?? null,
      })),
    });
  }
  catch { classification = { status: 'unavailable', workflowId: null, dialogueAct: 'other', confidence: 0, escalationReason: null, model: 'jev-1.13.0' }; }
  validateContract('boundary.schema.json#/$defs/classification', classification);
  if (demo.mode === 'frontline_qa' && classification.workflowId !== 'WF-06') classification = { ...classification, workflowId: classification.status === 'classified' ? 'WF-01' : null, escalationReason: null };
  const proposedEscalation = classification.escalationReason;
  const acceptedReason = acceptedEscalation(classification, workflow);
  const rejectedEscalation = classification.workflowId === 'WF-06' && !acceptedReason;
  classification = { ...classification, escalationReason: acceptedReason };
  turn.classification = classification;
  const urgent = classification.escalationReason;
  let target = urgent ? 'WF-06' : rejectedEscalation ? workflow.workflowId : classification.workflowId ?? workflow.workflowId;
  // A caller who asks for something this version has turned off is answered by WF-01, so no tool of that workflow is offered.
  if (disabledWorkflowIds(state, demo).has(target)) target = 'WF-01';
  const resumingSuspended = target !== 'WF-01' && workflow.workflowId === 'WF-01' && workflow.suspendedWorkflowId === target;
  const effectivePhase = resumingSuspended ? workflow.suspendedPhase : workflow.phase;
  let phase = urgent ? 'ending' : classification.status === 'classified' && !rejectedEscalation ? (target === 'WF-03' ? (resumingSuspended ? effectivePhase : 'collecting') : 'interpreting') : 'clarifying';
  const invalidatesRequestContext = target === 'WF-03' && ['correct', 'negate', 'provide_fields'].includes(classification.dialogueAct);
  if (invalidatesRequestContext) {
    workflow.currentValidation = null;
    workflow.readback = null;
    workflow.confirmation = null;
    phase = 'collecting';
  }
  let nextAction;
  if (urgent) nextAction = 'escalate';
  else if (classification.status !== 'classified' || rejectedEscalation) nextAction = 'clarify';
  else if (target === 'WF-03' && classification.dialogueAct === 'affirm' && effectivePhase === 'awaiting_confirmation' && workflow.readback) { nextAction = 'confirm'; phase = 'awaiting_confirmation'; }
  else if (target === 'WF-03' && workflow.currentValidation && workflow.missingFields?.length === 0 && !workflow.readback) { nextAction = 'readback'; phase = 'reading_back'; }
  else nextAction = ({ 'WF-01': 'answer', 'WF-02': 'collect', 'WF-03': 'collect', 'WF-04': 'lookup', 'WF-05': 'save_case', 'WF-06': 'clarify' }[target]);
  if (classification.status !== 'classified' || rejectedEscalation) workflow.clarificationCount += 1; else workflow.clarificationCount = 0;
  const publicWorkflow = setWorkflow(workflow, target, phase, demo.mode === 'frontline_qa' && target === 'WF-01' ? [] : allowedTools[target]);
  if (urgent) {
    const time = Date.now(); demo.state = 'ending'; demo.stateRevision = (demo.stateRevision ?? 1) + 1; demo.terminalReason = urgent; demo.reconnectAllowed = false;
    demo.endingResponse = { sessionId: demo.id, status: 'ending', reason: urgent, stateRevision: demo.stateRevision, endingAt: new Date(time).toISOString(), reconnectAllowed: false, closeDeadlineAt: new Date(Math.min(time + 10000, Date.parse(demo.hardEndAt))).toISOString(), workflowRevision: workflow.revision };
  }
  const promptContext = urgent ? 'End intake and begin the bounded escalation close.'
    : nextAction === 'readback' ? 'Read back every validated request field once and ask for a clear confirmation.'
      : nextAction === 'confirm' ? 'Bind this affirmative caller turn to the exact readback, save once, and state that the request is not booked or sent.'
        : demo.mode === 'frontline_qa' && nextAction === 'answer' ? 'Answer only with the approved Frontline product facts. Business lookup and intake are unavailable.'
          : classification.status === 'classified' && !rejectedEscalation ? 'Follow only the allowed tools for this workflow.'
          : workflow.clarificationCount > 1 || proposedEscalation === 'blocking_unknown' ? 'State that there is not enough information and offer the request-only fallback.' : 'Ask one focused clarification.';
  const decision = { callerTurn: { ...publicTurn, workflowRevision: publicWorkflow.revision }, classification, workflow: publicWorkflow, nextAction, promptContext };
  turn.decision = decision;
  return decision;
}

export function validateFields(state, demo, input) {
  assertBusinessDemo(demo); assertWorkflowEnabled(state, demo, 'WF-03'); validateContract('boundary.schema.json#/$defs/validateRequestInput', input); const workflow = ensureWorkflow(state, demo); assertActive(demo, workflow, input.expectedWorkflowRevision);
  assertTool(workflow, 'WF-03', 'validate_request', ['collecting']);
  const latest = (state.callerTurns[demo.id] ?? []).at(-1); if (!latest || latest.callerTurnId !== input.callerTurnId || latest.classification?.status !== 'classified' || latest.classification?.workflowId !== 'WF-03') throw problem(409, 'stale_caller_turn', 'Fields must bind to the latest authorized caller turn.');
  const fields = Object.fromEntries(Object.entries(input.fields).map(([k, v]) => [k, clean(v)]).filter(([, v]) => v));
  const missingFields = ['callerName', 'serviceNeed', 'propertyCity'].filter((key) => !fields[key]); if (!fields.contactPhone && !fields.contactEmail) missingFields.push('contactPhone', 'contactEmail');
  workflow.fields = fields; workflow.missingFields = missingFields; workflow.fieldRevision += 1; workflow.readback = null; workflow.confirmation = null; workflow.phase = 'collecting'; workflow.revision += 1;
  return workflow.currentValidation = { workflowInstanceId: workflow.workflowInstanceId, fieldRevision: workflow.fieldRevision, fields, missingFields, payloadHash: payloadHash(fields), workflowRevision: workflow.revision };
}

export function recordReadback(state, demo, input) {
  assertBusinessDemo(demo); assertWorkflowEnabled(state, demo, 'WF-03'); validateContract('boundary.schema.json#/$defs/readbackInput', input); const workflow = ensureWorkflow(state, demo); assertActive(demo, workflow, input.expectedWorkflowRevision);
  assertTool(workflow, 'WF-03', 'validate_request', ['collecting', 'reading_back']);
  if (workflow.fieldRevision !== input.fieldRevision || payloadHash(workflow.fields) !== input.payloadHash) throw problem(409, 'stale_readback', 'Fields changed before readback.');
  validateContract('boundary.schema.json#/$defs/completeRequestFields', workflow.fields);
  const turns = state.callerTurns[demo.id] ?? []; workflow.readbackRevision += 1; workflow.confirmation = null; workflow.phase = 'awaiting_confirmation'; workflow.revision += 1;
  return workflow.readback = { workflowInstanceId: workflow.workflowInstanceId, fieldRevision: workflow.fieldRevision, readbackRevision: workflow.readbackRevision, payloadHash: input.payloadHash, fields: workflow.fields, afterCallerTurnSequence: turns.at(-1)?.sequence ?? 1, serverRecordedAt: nowIso(), workflowRevision: workflow.revision };
}

export function confirmReadback(state, demo, input) {
  assertBusinessDemo(demo); assertWorkflowEnabled(state, demo, 'WF-03'); validateContract('boundary.schema.json#/$defs/confirmationInput', input); const workflow = ensureWorkflow(state, demo); assertActive(demo, workflow, input.expectedWorkflowRevision);
  assertTool(workflow, 'WF-03', 'save_request', ['awaiting_confirmation']);
  const latest = (state.callerTurns[demo.id] ?? []).at(-1); const binding = { confirmationId: randomUUID(), workflowInstanceId: workflow.workflowInstanceId, callerTurnId: input.callerTurnId, callerTurnSequence: latest?.sequence, fieldRevision: input.fieldRevision, readbackRevision: input.readbackRevision, readbackPayloadHash: input.payloadHash, serverRecordedAt: nowIso(), dialogueAct: 'affirm', workflowRevision: workflow.revision + 1 };
  try { validateConfirmationBinding(binding, { workflowInstanceId: workflow.workflowInstanceId, fieldRevision: workflow.fieldRevision, readbackRevision: workflow.readbackRevision, readbackPayloadHash: workflow.readback?.payloadHash, latestCallerTurnId: latest?.callerTurnId, latestCallerTurnSequence: latest?.sequence, latestCallerDialogueAct: latest?.classification?.dialogueAct, latestCallerClassificationStatus: latest?.classification?.status, readbackAfterCallerTurnSequence: workflow.readback?.afterCallerTurnSequence }); }
  catch { throw problem(409, 'stale_or_forged_confirmation', 'The latest caller turn did not confirm this exact readback.'); }
  workflow.confirmation = binding; workflow.phase = 'operating'; workflow.revision += 1; return binding;
}

function receipt(state, workflow, input, kind, recordFactory) {
  const hash = payloadHash(input); const old = state.receipts[input.operationId];
  if (old) { if (old.payloadHash !== hash || old.operationKind !== kind) throw problem(409, 'operation_conflict', 'Operation identifier was used with another payload.'); return old; }
  const record = recordFactory(); workflow.revision += 1;
  const result = { receiptId: randomUUID(), operationId: input.operationId, operationKind: kind, payloadHash: hash, workflowInstanceId: workflow.workflowInstanceId, workflowRevision: workflow.revision, recordedAt: nowIso(), sequence: Object.keys(state.receipts).length + 1, outcome: 'saved', recordId: record.recordId };
  record.receiptId = result.receiptId; state.receipts[input.operationId] = validateReceipt(result); return result;
}

export function saveRequest(state, demo, input) {
  assertBusinessDemo(demo); assertWorkflowEnabled(state, demo, 'WF-03'); validateContract('boundary.schema.json#/$defs/saveRequestInput', input); const workflow = ensureWorkflow(state, demo); const replay = state.receipts[input.operationId];
  if (replay) { if (replay.operationKind !== 'request' || replay.payloadHash !== payloadHash(input)) throw problem(409, 'operation_conflict', 'Operation identifier was used with another payload.'); return replay; }
  assertActive(demo, workflow, input.expectedWorkflowRevision);
  assertTool(workflow, 'WF-03', 'save_request', ['operating']);
  if (!workflow.confirmation || workflow.confirmation.confirmationId !== input.confirmationId || workflow.confirmation.fieldRevision !== workflow.fieldRevision) throw problem(409, 'confirmation_required', 'Confirm the current readback before saving.');
  return receipt(state, workflow, input, 'request', () => { const record = { recordId: randomUUID(), demoId: demo.id, workflowInstanceId: workflow.workflowInstanceId, knowledgeRevisionId: demo.knowledgeRevisionId, profileRevisionId: state.preparations[demo.preparationId]?.profileRevisionId ?? demo.knowledgeRevisionId, agentVersionId: demo.agentVersionId, fields: workflow.fields, confirmation: workflow.confirmation, receiptId: '', savedAt: nowIso(), bookingState: 'not_booked', deliveryState: 'not_sent' }; (state.outcomes[demo.id] ??= []).push(record); return record; });
}

export function lookupAppointment(state, demo, input, failureReason = null) {
  assertBusinessDemo(demo); assertWorkflowEnabled(state, demo, 'WF-04'); validateContract('boundary.schema.json#/$defs/lookupInput', input); const workflow = ensureWorkflow(state, demo);
  const hash = payloadHash(input); const old = state.lookups[input.operationId]; if (old) { if (old.payloadHash !== hash) throw problem(409, 'operation_conflict', 'Operation identifier was used with another payload.'); return old.result; }
  assertActive(demo, workflow, input.expectedWorkflowRevision);
  assertTool(workflow, 'WF-04', 'lookup_appointment', ['interpreting']);
  workflow.revision += 1; const result = failureReason ? { kind: 'unavailable', lookupId: randomUUID(), reason: failureReason, workflowRevision: workflow.revision } : { kind: 'not_found', lookupId: randomUUID(), workflowRevision: workflow.revision };
  state.lookups[input.operationId] = { payloadHash: hash, result, outcome: { demoId: demo.id, workflowInstanceId: workflow.workflowInstanceId, action: input.action, result, recordedAt: nowIso() } }; return result;
}

// An escalation is always for the owner to follow up (VA-D4), so it is saved as a Needs review note.
const escalationReview = (input) => ({ reviewStatus: 'needs_review', reviewedAt: null, endedBecause: input.reason,
  missingFields: missingFieldsFor('escalation', input.context) });

// An escalation during an open request is already one Needs review note: the call's ending turned that request into a
// note with endedBecause set to this reason. The escalation receipt points at that note instead of adding a second one.
function taskNoteEndedBy(state, demo, workflow, reason) {
  return [...(state.outcomes?.[demo.id] ?? []), ...(state.cases?.[demo.id] ?? [])]
    .find((record) => record.workflowInstanceId === workflow.workflowInstanceId && record.endedBecause === reason && record.kind !== 'escalation') ?? null;
}

export function saveCase(state, demo, input, escalation = false) {
  assertBusinessDemo(demo); if (!escalation) assertWorkflowEnabled(state, demo, 'WF-05'); validateContract(escalation ? 'boundary.schema.json#/$defs/escalationInput' : 'boundary.schema.json#/$defs/saveCaseInput', input); const workflow = ensureWorkflow(state, demo); const replay = state.receipts[input.operationId];
  if (replay) { const kind = escalation ? 'escalation' : 'case'; if (replay.operationKind !== kind || replay.payloadHash !== payloadHash(input)) throw problem(409, 'operation_conflict', 'Operation identifier was used with another payload.'); return replay; }
  if (!escalation) {
    assertActive(demo, workflow, input.expectedWorkflowRevision);
    assertTool(workflow, 'WF-05', 'save_case', ['interpreting']);
  } else {
    if (workflow.phase !== 'ending' || workflow.revision !== input.expectedWorkflowRevision) throw problem(409, 'stale_workflow', 'Escalation is not bound to the ending transition.');
    assertTool(workflow, 'WF-06', 'record_escalation', ['ending']);
  }
  assertCaseBinding(state, demo, input, escalation);
  return receipt(state, workflow, input, escalation ? 'escalation' : 'case', () => { const noted = escalation ? taskNoteEndedBy(state, demo, workflow, input.reason) : null; if (noted) return noted; const record = { recordId: randomUUID(), demoId: demo.id, workflowInstanceId: workflow.workflowInstanceId, kind: escalation ? 'escalation' : 'complaint', context: input.context, escalationReason: escalation ? input.reason : null, receiptId: '', savedAt: nowIso(), deliveryState: 'not_sent', ...(escalation ? escalationReview(input) : {}) }; (state.cases[demo.id] ??= []).push(record); return record; });
}

export function beginEnding(state, demo, input) {
  validateContract('boundary.schema.json#/$defs/endingInput', input); const workflow = ensureWorkflow(state, demo); const revision = demo.stateRevision ?? 1;
  if (demo.state === 'ending' && demo.terminalReason === input.reason) return demo.endingResponse;
  if (demo.state !== 'active' || revision !== input.expectedStateRevision) throw problem(409, 'stale_session', 'Session state changed.');
  demo.state = 'ending'; demo.stateRevision = revision + 1; demo.terminalReason = input.reason; workflow.workflowId = 'WF-06'; workflow.phase = 'ending'; workflow.allowedToolIds = allowedTools['WF-06']; workflow.suspendedWorkflowId = null; workflow.revision += 1;
  noteOpenTasks(state, demo, input.reason);
  demo.reconnectAllowed = false;
  const hardEnd = Date.parse(demo.hardEndAt);
  return demo.endingResponse = validateContract('boundary.schema.json#/$defs/endingSession', { sessionId: demo.id, status: 'ending', reason: input.reason, stateRevision: demo.stateRevision, endingAt: nowIso(), reconnectAllowed: false, closeDeadlineAt: new Date(Number.isFinite(hardEnd) ? Math.min(Date.now() + 10000, hardEnd) : Date.now() + 10000).toISOString(), workflowRevision: workflow.revision });
}

export function finishTerminal(state, demo, input) {
  validateContract('boundary.schema.json#/$defs/endingInput', input); const workflow = ensureWorkflow(state, demo);
  if (demo.state === 'ended' && demo.terminalReason === input.reason && demo.terminalResponse) return demo.terminalResponse;
  if (demo.state !== 'ending' || (demo.stateRevision ?? 1) !== input.expectedStateRevision || demo.terminalReason !== input.reason) throw problem(409, 'stale_session', 'Session state changed.');
  demo.state = 'ended'; demo.stateRevision += 1; demo.endedAt = nowIso(); demo.reconnectAllowed = false; workflow.phase = 'terminal'; workflow.allowedToolIds = ['end_session']; workflow.revision += 1;
  noteOpenTasks(state, demo, input.reason);
  return demo.terminalResponse = validateTerminalSession({ sessionId: demo.id, status: 'terminal', reason: input.reason, stateRevision: demo.stateRevision, terminalAt: demo.endedAt, reconnectAllowed: false, workflowRevision: workflow.revision });
}

export function forceTerminal(state, demo, reason, persistedState = 'ended') {
  validateContract('boundary.schema.json#/$defs/endingInput', { expectedStateRevision: demo.stateRevision ?? 1, reason });
  const workflow = ensureWorkflow(state, demo);
  if (['ended', 'failed'].includes(demo.state) && demo.terminalReason === reason && demo.terminalResponse) return demo.terminalResponse;
  demo.state = persistedState;
  demo.stateRevision = (demo.stateRevision ?? 1) + 1;
  demo.terminalReason = reason;
  demo.reconnectAllowed = false;
  demo.endedAt ??= nowIso();
  workflow.workflowId = 'WF-06'; workflow.phase = 'terminal'; workflow.allowedToolIds = ['end_session']; workflow.suspendedWorkflowId = null; workflow.revision += 1;
  noteOpenTasks(state, demo, reason);
  return demo.terminalResponse = validateTerminalSession({ sessionId: demo.id, status: 'terminal', reason, stateRevision: demo.stateRevision, terminalAt: demo.endedAt, reconnectAllowed: false, workflowRevision: workflow.revision });
}
