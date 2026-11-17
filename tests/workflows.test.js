import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { beginEnding, confirmReadback, finishTerminal, forceTerminal, lookupAppointment, recordReadback, recordTurn, saveCase, saveRequest, validateFields } from '../server/api/workflows.js';
import { createJevClassifier } from '../server/api/jev-classifier.js';

const classified = (workflowId, dialogueAct = 'provide_fields', escalationReason = null) => ({ status: 'classified', workflowId, dialogueAct, confidence: 0.99, escalationReason, model: 'jev-1.13.0' });
function fixture() {
  const demoId = randomUUID(); const preparationId = randomUUID(); const knowledgeRevisionId = randomUUID(); const agentVersionId = randomUUID();
  const demo = { id: demoId, mode: 'business_demo', state: 'active', stateRevision: 1, preparationId, knowledgeRevisionId, agentVersionId, hardEndAt: new Date(Date.now() + 300_000).toISOString() };
  const state = { demos: { [demoId]: demo }, preparations: { [preparationId]: { profileRevisionId: randomUUID() } }, workflows: {}, callerTurns: {}, outcomes: {}, cases: {}, lookups: {}, receipts: {} };
  return { state, demo };
}

describe('frozen Bayside workflows', () => {
  it('routes all six workflows using server classification and resumes one side question', async () => {
    for (const id of ['WF-01', 'WF-02', 'WF-03', 'WF-04', 'WF-05', 'WF-06']) {
      const { state, demo } = fixture();
      const decision = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'caller speech', finalized: true, expectedWorkflowRevision: 1 }, async () => classified(id, id === 'WF-06' ? 'request_human' : 'other', id === 'WF-06' ? 'human_preference' : null));
      expect(decision.workflow.workflowId).toBe(id); expect(decision.classification.model).toBe('jev-1.13.0');
    }
    const { state, demo } = fixture();
    await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'request', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-03'));
    const side = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'hours?', finalized: true, expectedWorkflowRevision: 2 }, async () => classified('WF-01', 'question'));
    expect(side.workflow.suspendedWorkflowId).toBe('WF-03');
  });

  it('restores a suspended request phase so an affirmative turn confirms the exact readback', async () => {
    const { state, demo } = fixture();
    const request = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'request', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-03'));
    const validation = validateFields(state, demo, { expectedWorkflowRevision: request.workflow.revision, callerTurnId: request.callerTurn.callerTurnId, fields: { callerName: 'Sam', contactPhone: '555 0100', serviceNeed: 'washing', propertyCity: 'Irvine' } });
    const readback = recordReadback(state, demo, { expectedWorkflowRevision: validation.workflowRevision, fieldRevision: validation.fieldRevision, payloadHash: validation.payloadHash });
    const side = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'What are your hours?', finalized: true, expectedWorkflowRevision: readback.workflowRevision }, async () => classified('WF-01', 'question'));
    expect(side.workflow).toMatchObject({ workflowId: 'WF-01', suspendedWorkflowId: 'WF-03' });
    const affirm = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'Yes', finalized: true, expectedWorkflowRevision: side.workflow.revision }, async () => classified('WF-03', 'affirm'));
    expect(affirm).toMatchObject({ nextAction: 'confirm', workflow: { workflowId: 'WF-03', phase: 'awaiting_confirmation', suspendedWorkflowId: null } });
  });

  it('binds a saved request to exact fields, readback and later positive caller turn', async () => {
    const { state, demo } = fixture();
    const first = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'My details', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-03'));
    const fields = { callerName: 'Sam', contactEmail: 'sam@example.com', serviceNeed: 'commercial pressure washing', propertyCity: 'Long Beach', preferredDay: 'Friday' };
    const validation = validateFields(state, demo, { expectedWorkflowRevision: first.workflow.revision, callerTurnId: first.callerTurn.callerTurnId, fields });
    const readback = recordReadback(state, demo, { expectedWorkflowRevision: validation.workflowRevision, fieldRevision: validation.fieldRevision, payloadHash: validation.payloadHash });
    const affirm = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'Yes, that is correct', finalized: true, expectedWorkflowRevision: readback.workflowRevision }, async () => classified('WF-03', 'affirm'));
    const confirmation = confirmReadback(state, demo, { callerTurnId: affirm.callerTurn.callerTurnId, fieldRevision: readback.fieldRevision, readbackRevision: readback.readbackRevision, payloadHash: readback.payloadHash, expectedWorkflowRevision: affirm.workflow.revision });
    const operationId = randomUUID(); const receipt = saveRequest(state, demo, { operationId, expectedWorkflowRevision: confirmation.workflowRevision, confirmationId: confirmation.confirmationId });
    expect(receipt.outcome).toBe('saved'); expect(state.outcomes[demo.id][0]).toMatchObject({ fields, bookingState: 'not_booked', deliveryState: 'not_sent' });
    expect(saveRequest(state, demo, { operationId, expectedWorkflowRevision: confirmation.workflowRevision, confirmationId: confirmation.confirmationId })).toEqual(receipt);
  });

  it('rejects negation and corrections as confirmation', async () => {
    for (const act of ['negate', 'correct']) {
      const { state, demo } = fixture(); const initial = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'details', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-03'));
      const validated = validateFields(state, demo, { expectedWorkflowRevision: initial.workflow.revision, callerTurnId: initial.callerTurn.callerTurnId, fields: { callerName: 'Sam', contactPhone: '555 0100', serviceNeed: 'washing', propertyCity: 'Irvine' } });
      const readback = recordReadback(state, demo, { expectedWorkflowRevision: validated.workflowRevision, fieldRevision: validated.fieldRevision, payloadHash: validated.payloadHash });
      const response = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'No', finalized: true, expectedWorkflowRevision: readback.workflowRevision }, async () => classified('WF-03', act));
      expect(state.workflows[demo.id]).toMatchObject({ currentValidation: null, readback: null, confirmation: null });
      expect(() => confirmReadback(state, demo, { callerTurnId: response.callerTurn.callerTurnId, fieldRevision: readback.fieldRevision, readbackRevision: readback.readbackRevision, payloadHash: readback.payloadHash, expectedWorkflowRevision: response.workflow.revision })).toThrow(/not allowed by the current workflow/i);
    }
  });

  it('separates empty lookup from lookup failure without disclosing records', async () => {
    const { state, demo } = fixture();
    const turn = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'cancel', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-04'));
    const first = lookupAppointment(state, demo, { operationId: randomUUID(), expectedWorkflowRevision: turn.workflow.revision, callerName: 'Pat', action: 'cancel' });
    expect(first.kind).toBe('not_found');
    const failed = lookupAppointment(state, demo, { operationId: randomUUID(), expectedWorkflowRevision: first.workflowRevision, callerName: 'Pat', action: 'reschedule' }, 'storage_error');
    expect(failed).toMatchObject({ kind: 'unavailable', reason: 'storage_error' }); expect(failed).not.toHaveProperty('appointment');
  });

  it.each(['human_preference', 'urgency', 'safety_emergency'])('fences writes immediately for %s and terminates independently', async (reason) => {
    vi.useFakeTimers(); const { state, demo } = fixture();
    const decision = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'stop', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-06', 'request_human', reason));
    expect(demo).toMatchObject({ state: 'ending', reconnectAllowed: false, terminalReason: reason });
    expect(() => validateFields(state, demo, { expectedWorkflowRevision: decision.workflow.revision, callerTurnId: decision.callerTurn.callerTurnId, fields: {} })).toThrow(/no longer accepts/i);
    const receipt = saveCase(state, demo, { operationId: randomUUID(), expectedWorkflowRevision: decision.workflow.revision, reason, context: { summary: 'Caller requested help.', callerTurnIds: [decision.callerTurn.callerTurnId] } }, true);
    expect(receipt.outcome).toBe('saved');
    const terminal = finishTerminal(state, demo, { expectedStateRevision: demo.stateRevision, reason }); expect(terminal).toMatchObject({ status: 'terminal', reconnectAllowed: false });
    expect(demo.state).toBe('ended');
    vi.useRealTimers();
  });

  it('uses one clarification before accepting a blocking-unknown escalation', async () => {
    const { state, demo } = fixture();
    const clarification = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'I need certainty', finalized: true, expectedWorkflowRevision: 1 }, async () => ({ status: 'clarification_required', workflowId: null, dialogueAct: 'other', confidence: 0.4, escalationReason: null, model: 'jev-1.13.0' }));
    expect(clarification.nextAction).toBe('clarify'); expect(demo.state).toBe('active');
    const ending = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'I cannot proceed without it', finalized: true, expectedWorkflowRevision: clarification.workflow.revision }, async () => classified('WF-06', 'other', 'blocking_unknown'));
    expect(ending.nextAction).toBe('escalate'); expect(demo).toMatchObject({ state: 'ending', terminalReason: 'blocking_unknown' });
  });

  it('does not end for low-confidence or inconsistent escalation output', async () => {
    for (const classification of [
      { status: 'clarification_required', workflowId: null, dialogueAct: 'request_human', confidence: 0.4, escalationReason: 'human_preference', model: 'jev-1.13.0' },
      classified('WF-06', 'other', 'human_preference'),
    ]) {
      const { state, demo } = fixture();
      const decision = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'ambiguous', finalized: true, expectedWorkflowRevision: 1 }, async () => classification);
      expect(decision.classification.escalationReason).toBeNull(); expect(demo.state).toBe('active');
    }
  });

  it('replays an exact caller turn before checking a stale workflow revision', async () => {
    const { state, demo } = fixture(); const classify = vi.fn(async () => classified('WF-03'));
    const input = { clientTurnId: randomUUID(), text: 'Please take a request', finalized: true, expectedWorkflowRevision: 1 };
    const first = await recordTurn(state, demo, input, classify);
    expect(await recordTurn(state, demo, input, classify)).toEqual(first); expect(classify).toHaveBeenCalledTimes(1);
  });

  it('denies cross-workflow mutations but preserves exact operation replay', async () => {
    const { state, demo } = fixture();
    const question = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'hours', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-01', 'question'));
    expect(() => validateFields(state, demo, { expectedWorkflowRevision: question.workflow.revision, callerTurnId: question.callerTurn.callerTurnId, fields: { callerName: 'Sam' } })).toThrow(/not allowed/i);
    expect(() => lookupAppointment(state, demo, { operationId: randomUUID(), expectedWorkflowRevision: question.workflow.revision, callerName: 'Sam', action: 'cancel' })).toThrow(/not allowed/i);
    expect(() => saveCase(state, demo, { operationId: randomUUID(), expectedWorkflowRevision: question.workflow.revision, kind: 'complaint', context: { summary: 'Unauthorized complaint', callerTurnIds: [question.callerTurn.callerTurnId] } })).toThrow(/not allowed/i);

    const complaint = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'complaint', finalized: true, expectedWorkflowRevision: question.workflow.revision }, async () => classified('WF-05'));
    const input = { operationId: randomUUID(), expectedWorkflowRevision: complaint.workflow.revision, kind: 'complaint', context: { summary: 'Poor service', callerTurnIds: [complaint.callerTurn.callerTurnId] } };
    const saved = saveCase(state, demo, input);
    await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'hours', finalized: true, expectedWorkflowRevision: saved.workflowRevision }, async () => classified('WF-01', 'question'));
    expect(saveCase(state, demo, input)).toEqual(saved);
  });

  it('passes bounded task context to Jev without caller field values', async () => {
    const systemOne = vi.fn(/** @param {any} _input */ async (_input) => ({ model: 'jev-1.13.0', answers: {
      workflow: { choice: 'WF-03', confidence: 0.99 }, dialogueAct: { choice: 'affirm', confidence: 0.99 }, escalation: { choice: 'none', confidence: 0.99 },
    } }));
    const classifier = createJevClassifier({ client: { systemOne } });
    await classifier.classify('Yes', { demo: { mode: 'business_demo' }, workflow: { workflowId: 'WF-01', phase: 'interpreting', suspendedWorkflowId: 'WF-03', suspendedPhase: 'awaiting_confirmation', fields: { callerName: 'Sensitive Name' }, missingFields: [], currentValidation: {}, readback: {} }, recentCallerTurns: [{ sequence: 7, workflowId: 'WF-03', dialogueAct: 'provide_fields', text: 'Sensitive Name' }] });
    /** @type {any} */
    const state = systemOne.mock.calls.at(0)?.at(0)?.state;
    expect(state).toMatchObject({ finalizedCallerText: 'Yes', currentWorkflowId: 'WF-01', suspendedWorkflowId: 'WF-03', suspendedPhase: 'awaiting_confirmation', pendingFieldNames: ['callerName'], hasCurrentValidation: true, hasCurrentReadback: true, recentCallerTurns: [{ sequence: 7, workflowId: 'WF-03', dialogueAct: 'provide_fields' }] });
    expect(JSON.stringify(state)).not.toContain('Sensitive Name');
  });

  it('keeps Frontline Q&A in product-only workflow authority', async () => {
    const { state, demo } = fixture(); demo.mode = 'frontline_qa';
    const decision = await recordTurn(state, demo, { clientTurnId: randomUUID(), text: 'Take an appointment request', finalized: true, expectedWorkflowRevision: 1 }, async () => classified('WF-03'));
    expect(decision).toMatchObject({ nextAction: 'answer', workflow: { workflowId: 'WF-01', allowedToolIds: [] }, classification: { workflowId: 'WF-01' } });
    expect(() => validateFields(state, demo, { expectedWorkflowRevision: decision.workflow.revision, callerTurnId: decision.callerTurn.callerTurnId, fields: {} })).toThrow(/Frontline Q&A mode/i);
  });

  it('supports explicit ending when no classification trigger initiated it', () => {
    const { state, demo } = fixture(); const ending = beginEnding(state, demo, { expectedStateRevision: 1, reason: 'caller_ended' });
    expect(ending.status).toBe('ending'); expect(finishTerminal(state, demo, { expectedStateRevision: 2, reason: 'caller_ended' }).status).toBe('terminal'); expect(demo.state).toBe('ended');
  });

  it('records the same terminal metadata for watchdog endings', () => {
    const { state, demo } = fixture();
    const terminal = forceTerminal(state, demo, 'hard_end_elapsed');
    expect(terminal).toMatchObject({ status: 'terminal', reason: 'hard_end_elapsed', reconnectAllowed: false });
    expect(demo).toMatchObject({ state: 'ended', terminalReason: 'hard_end_elapsed', reconnectAllowed: false, stateRevision: 2 });
  });
});
