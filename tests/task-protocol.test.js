import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateContract } from '../contracts/v1/contract-validator.js';
import { withNextStep } from '../server/api/next-step.js';
import { DevelopmentStore } from '../server/api/store.js';
import { missingFieldsFor, normalizeField } from '../server/api/task-records.js';
import { taskCommand, taskEnd } from '../server/api/tasks.js';
import { beginEnding, finishTerminal, forceTerminal, recordTurn, saveCase } from '../server/api/workflows.js';

// Voice agent v2 backend contract (VA-C1): start, record, finish and cancel, with Needs review notes on every terminal path.
describe('bob-task-v1 task commands (voice agent v2)', () => {
  let directory; let store; let demo;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frontline-task-protocol-'));
    store = new DevelopmentStore(join(directory, 'state.json'));
    const id = randomUUID();
    demo = { id, mode: 'business_demo', callArchitectureVersion: 'bob-task-v1', state: 'active', stateRevision: 1,
      preparationId: randomUUID(), knowledgeRevisionId: randomUUID(), agentVersionId: randomUUID(),
      hardEndAt: new Date(Date.now() + 300_000).toISOString() };
    await store.transaction((state) => { state.demos[id] = demo; state.preparations[demo.preparationId] = { profileRevisionId: demo.knowledgeRevisionId }; });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const run = (action) => store.transaction((state) => action(state, state.demos[demo.id]));
  const turn = (text) => run((state, current) => recordTurn(state, current, { clientTurnId: randomUUID(), text, finalized: true }, null, false));
  const command = (input, options) => run((state, current) => taskCommand(state, current, input, options));
  const start = (callerTurnId, kind = 'service_request', goal = 'Driveway washing request') => command({ action: 'start', taskId: randomUUID(), kind, callerTurnId, goal });
  const record = (task, callerTurnId, fields, operationId = randomUUID()) => command({ action: 'record', taskId: task.taskId, operationId, callerTurnId, fields });
  const op = (action, task, callerTurnId) => ({ action, taskId: task.taskId, operationId: randomUUID(), callerTurnId });
  const saved = async () => store.read();

  it('records partial details per field, saves the request on the completing record, and replays by operationId', async () => {
    const first = await turn('Hi, this is Maria, I need my driveway pressure washed in Tustin.');
    let result = await start(first.callerTurnId);
    validateContract('task.schema.json#/$defs/response', result);
    expect(result.task).toMatchObject({ status: 'running', fields: {}, noteRecordId: null });
    result = await record(result.task, first.callerTurnId, { callerName: 'Maria Lopez', serviceNeed: 'Driveway pressure washing', propertyCity: 'Tustin', contactPhone: '555-0100' });
    validateContract('task.schema.json#/$defs/response', result);
    expect(result.accepted).toEqual({ callerName: 'Maria Lopez', serviceNeed: 'Driveway pressure washing', propertyCity: 'Tustin' });
    expect(result.rejected).toEqual({ contactPhone: "That isn't a complete US phone number." });
    expect(result.task).toMatchObject({ status: 'running', missingFields: ['contactPhone', 'contactEmail', 'propertyState'] });
    // Any finalized caller turn of the call is accepted, including one that is no longer the latest.
    await turn('Do you guys also do patios?');
    const phoneOp = randomUUID();
    result = await record(result.task, first.callerTurnId, { contactPhone: '+1 (408) 555-2147' }, phoneOp);
    expect(result.task.fields.contactPhone).toBe('(408) 555-2147');
    expect(result.task.missingFields).toEqual(['phoneConfirmed', 'propertyState']);
    const yes = await turn('Yes, that number is right, and Tustin, California.');
    const completeOp = randomUUID();
    const done = await record(result.task, yes.callerTurnId, { phoneConfirmed: true, cityConfirmed: true }, completeOp);
    validateContract('task.schema.json#/$defs/response', done);
    expect(done.task).toMatchObject({ status: 'succeeded', missingFields: [], receipt: { outcome: 'saved', operationKind: 'request' } });
    const state = await saved();
    expect(state.outcomes[demo.id]).toHaveLength(1);
    const outcome = state.outcomes[demo.id][0];
    expect(outcome).toMatchObject({ kind: 'service_request', taskId: done.task.taskId, reviewStatus: 'needs_review', missingFields: [],
      endedBecause: null, bookingState: 'not_booked', deliveryState: 'not_sent', receiptId: done.task.receipt.receiptId, confirmation: null,
      fields: { callerName: 'Maria Lopez', contactPhone: '(408) 555-2147', phoneConfirmed: true, propertyCity: 'Tustin', cityConfirmed: true } });
    expect(done.task.noteRecordId).toBe(outcome.recordId);
    validateContract('boundary.schema.json#/$defs/requestRecord', withNextStep(outcome));
    expect(withNextStep(outcome).nextStep).toBe('Call Maria at (408) 555-2147 to follow up.');
    // Exact replays return the first result; a changed payload under the same operationId conflicts.
    expect(await record(done.task, yes.callerTurnId, { phoneConfirmed: true, cityConfirmed: true }, completeOp)).toEqual(done);
    expect((await record(done.task, first.callerTurnId, { contactPhone: '+1 (408) 555-2147' }, phoneOp)).task.status).toBe('running');
    await expect(record(done.task, yes.callerTurnId, { phoneConfirmed: true, cityConfirmed: false }, completeOp)).rejects.toMatchObject({ code: 'operation_conflict' });
    expect((await saved()).outcomes[demo.id]).toHaveLength(1);
    expect(Object.values((await saved()).receipts)).toHaveLength(1);
  });

  it('keeps a saved request open to changes until the call ends, then locks it', async () => {
    const first = await turn('This is Maria, driveway washing in Irvine, California, 408 555 2147.');
    let result = await start(first.callerTurnId);
    result = await record(result.task, first.callerTurnId, { callerName: 'Maria', serviceNeed: 'Driveway washing', propertyCity: 'Irvine',
      propertyState: 'CA', contactPhone: '408-555-2147', phoneConfirmed: true });
    expect(result.task.status).toBe('succeeded');
    const receiptId = result.task.receipt.receiptId;
    // The caller corrects the city and adds the exact address after the save.
    const change = await turn("Actually it's in Tustin, at 12 Main Street.");
    result = await record(result.task, change.callerTurnId, { propertyCity: 'Tustin', notes: 'Property: 12 Main Street.' });
    expect(result.task).toMatchObject({ status: 'succeeded', missingFields: ['propertyState'], receipt: { receiptId } });
    let outcome = (await saved()).outcomes[demo.id][0];
    expect(outcome.fields).toMatchObject({ propertyCity: 'Tustin', notes: 'Property: 12 Main Street.' });
    expect(outcome.fields).not.toHaveProperty('propertyState');
    expect(outcome.missingFields).toEqual(['propertyState']);
    // A new number is unconfirmed until it is read back, and the record says so.
    result = await record(result.task, change.callerTurnId, { propertyState: 'California', contactPhone: '714-555-2368' });
    expect(result.task.missingFields).toEqual(['phoneConfirmed']);
    result = await record(result.task, change.callerTurnId, { phoneConfirmed: true });
    outcome = (await saved()).outcomes[demo.id][0];
    expect(outcome).toMatchObject({ receiptId, missingFields: [], fields: { contactPhone: '(714) 555-2368', phoneConfirmed: true, propertyState: 'California' } });
    expect((await saved()).outcomes[demo.id]).toHaveLength(1);
    expect(Object.values((await saved()).receipts)).toHaveLength(1);
    validateContract('boundary.schema.json#/$defs/requestRecord', withNextStep(outcome));
    // Once the call is ending, the request is final.
    await run((state, current) => beginEnding(state, current, { expectedStateRevision: 1, reason: 'caller_ended' }));
    await expect(record(result.task, change.callerTurnId, { callerName: 'Maria Lopez' })).rejects.toMatchObject({ code: 'session_ending' });
    expect((await saved()).outcomes[demo.id][0].fields.callerName).toBe('Maria');
  });

  it('tells the owner to call back a caller who asked to talk to them', () => {
    const fields = { callerName: 'Maria Lopez', contactPhone: '(408) 555-2147', notes: 'Property: 12 Main Street. Asked to talk to the owner.' };
    expect(withNextStep({ kind: 'service_request', fields, missingFields: [] }).nextStep).toBe('Call Maria back at (408) 555-2147. They asked to talk to a person.');
  });

  it('rejects numbers that cannot exist and asks again for a confirmation when the number changes', async () => {
    const first = await turn('Driveway washing, this is Sam.');
    let result = await start(first.callerTurnId);
    for (const phone of ['555-0100', '408 555 214']) {
      result = await record(result.task, first.callerTurnId, { contactPhone: phone });
      expect(result.rejected).toEqual({ contactPhone: "That isn't a complete US phone number." });
    }
    for (const phone of ['123-456-7890', '408-055-2147']) {
      result = await record(result.task, first.callerTurnId, { contactPhone: phone });
      expect(result.rejected.contactPhone).toMatch(/doesn't look like a working US number/);
    }
    // Tom's 2026-10-03 call: a number the caller stands by is kept as they gave it, so the request is not lost.
    result = await record(result.task, first.callerTurnId, { contactPhone: '408-123-4567', phoneAsGiven: true });
    expect(result.task.fields).toMatchObject({ contactPhone: '(408) 123-4567', phoneAsGiven: true });
    result = await record(result.task, first.callerTurnId, { contactPhone: '408 555 214', phoneAsGiven: true });
    expect(result.rejected).toEqual({ contactPhone: "That isn't a complete US phone number." });
    result = await record(result.task, first.callerTurnId, { contactPhone: '408-555-2147' });
    result = await record(result.task, first.callerTurnId, { phoneConfirmed: true });
    expect(result.task.fields.phoneConfirmed).toBe(true);
    result = await record(result.task, first.callerTurnId, { contactPhone: '408-555-2148' });
    expect(result.task.fields).not.toHaveProperty('phoneConfirmed');
    expect(result.task.missingFields).toContain('phoneConfirmed');
  });

  it('accepts a state instead of a confirmation, an email instead of a phone, and resets the state when the city changes', async () => {
    const first = await turn('I need gutter cleaning.');
    let result = await start(first.callerTurnId);
    result = await record(result.task, first.callerTurnId, { callerName: 'Sam', serviceNeed: 'Gutter cleaning', propertyCity: 'Irvine', propertyState: 'CA' });
    expect(result.task.missingFields).toEqual(['contactPhone', 'contactEmail']);
    result = await record(result.task, first.callerTurnId, { propertyCity: 'Tustin' });
    expect(result.task.fields).not.toHaveProperty('propertyState');
    expect(result.task.missingFields).toEqual(['contactPhone', 'contactEmail', 'propertyState']);
    result = await record(result.task, first.callerTurnId, { propertyState: 'California', contactEmail: '  Sam@Example.com ' });
    expect(result.accepted.contactEmail).toBe('sam@example.com');
    expect(result.task.status).toBe('succeeded');
  });

  it('validates each field on its own', () => {
    expect(normalizeField('contactPhone', '408.555.2147')).toEqual({ value: '(408) 555-2147' });
    expect(normalizeField('contactPhone', '14085552147')).toEqual({ value: '(408) 555-2147' });
    expect(normalizeField('contactPhone', '24085552147')).toHaveProperty('reason');
    expect(normalizeField('contactPhone', '408 555 2147 ext 2')).toHaveProperty('reason');
    expect(normalizeField('contactEmail', 'not-an-email')).toHaveProperty('reason');
    expect(normalizeField('callerName', '1234')).toHaveProperty('reason');
    expect(normalizeField('callerName', '  Maria   Lopez ')).toEqual({ value: 'Maria Lopez' });
    expect(normalizeField('serviceNeed', '   ')).toEqual({ reason: 'This was empty.' });
    expect(normalizeField('serviceNeed', 'x'.repeat(501))).toHaveProperty('reason');
    expect(normalizeField('cityConfirmed', 'yes')).toEqual({ reason: 'Send true or false.' });
    expect(normalizeField('noContact', true)).toEqual({ value: true });
    expect(normalizeField('appointmentAction', 'Reschedule')).toEqual({ value: 'reschedule' });
    expect(normalizeField('appointmentAction', 'move')).toHaveProperty('reason');
    expect(normalizeField('preferredDay', 'Tuesday')).toEqual({ reason: "Blake can't record this detail." });
    // A caller calling for someone else: who it is for and the property go in notes, both already in the v1 contract.
    expect(normalizeField('notes', ' Calling for Mike.  Property: Westpark Plaza. ')).toEqual({ value: 'Calling for Mike. Property: Westpark Plaza.' });
    expect(normalizeField('company', 'Westpark Plaza LLC')).toEqual({ value: 'Westpark Plaza LLC' });
    expect(normalizeField('notes', 'x'.repeat(501))).toHaveProperty('reason');
    expect(normalizeField('summary', 42)).toEqual({ reason: 'Send this as words.' });
    expect(missingFieldsFor('service_request', { callerName: 'A', serviceNeed: 'B', contactEmail: 'a@b.co', propertyCity: 'C', cityConfirmed: true })).toEqual([]);
    expect(missingFieldsFor('complaint', { summary: 'Late', callerName: 'A', noContact: true })).toEqual([]);
    // The owner finds an appointment by the caller's name, so contact details are never missing for one.
    expect(missingFieldsFor('appointment_lookup', {})).toEqual(['callerName', 'appointmentAction']);
  });

  it('rejects unknown turns and oversized records, and needs no workflow revision', async () => {
    const first = await turn('Please wash my driveway.');
    const result = await start(first.callerTurnId);
    await expect(record(result.task, randomUUID(), { callerName: 'Sam' })).rejects.toMatchObject({ code: 'unknown_caller_turn' });
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field${index}`, 'x']));
    await expect(record(result.task, first.callerTurnId, many)).rejects.toMatchObject({ code: 'invalid_task_command', status: 400 });
    await expect(command({ action: 'input', taskId: result.task.taskId, callerTurnId: first.callerTurnId })).rejects.toMatchObject({ code: 'invalid_task_command' });
    await expect(command({ ...op('tool', result.task, first.callerTurnId), tool: 'validate_request', arguments: {} })).rejects.toMatchObject({ code: 'invalid_task_command' });
    const withRevision = await command({ ...op('record', result.task, first.callerTurnId), expectedWorkflowRevision: 99, fields: { callerName: 'Sam' } });
    expect(withRevision.accepted).toEqual({ callerName: 'Sam' });
  });

  it('returns the open task for a second start of the same kind and refuses another kind', async () => {
    const first = await turn('I need my windows cleaned.');
    const startInput = { action: 'start', taskId: randomUUID(), kind: 'service_request', callerTurnId: first.callerTurnId, goal: 'Window cleaning' };
    const opened = await command(startInput);
    expect((await command({ ...startInput, goal: '  Window cleaning  ' })).task.taskId).toBe(opened.task.taskId);
    await expect(command({ ...startInput, kind: 'complaint' })).rejects.toMatchObject({ code: 'task_conflict' });
    const second = await turn('Yes, let us do that.');
    expect((await start(second.callerTurnId, 'service_request', 'Another goal')).task.taskId).toBe(opened.task.taskId);
    await expect(start(second.callerTurnId, 'complaint', 'A complaint')).rejects.toMatchObject({ code: 'task_already_active' });
  });

  it('preserves bounded same-session caller context before assent delegates a task', async () => {
    for (let i = 0; i < 13; i += 1) await turn(`Older conversational turn ${i}`);
    const scope = await turn('A commercial plaza with about 20 stores needs its entrances and trash areas cleaned.');
    const assent = await turn("Yeah, that'd be great.");
    const result = await start(assent.callerTurnId);
    expect(result.task.evidenceTurns).toHaveLength(12);
    expect(result.task.evidenceTurns.slice(-2)).toEqual([
      { callerTurnId: scope.callerTurnId, sequence: scope.sequence, text: scope.text },
      { callerTurnId: assent.callerTurnId, sequence: assent.sequence, text: assent.text },
    ]);
    validateContract('task.schema.json#/$defs/response', result);
  });

  it('cancels into stopped with the fields kept, then notes the stopped task once when the call ends', async () => {
    const first = await turn('I need a quote for roof cleaning.');
    let result = await start(first.callerTurnId);
    result = await record(result.task, first.callerTurnId, { callerName: 'Pat', serviceNeed: 'Roof cleaning' });
    const cancel = op('cancel', result.task, first.callerTurnId);
    const stopped = await command(cancel);
    expect(stopped.task).toMatchObject({ status: 'stopped', fields: { callerName: 'Pat', serviceNeed: 'Roof cleaning' } });
    expect(await command(cancel)).toEqual(stopped);
    await expect(record(stopped.task, first.callerTurnId, { contactPhone: '4085552147' })).rejects.toMatchObject({ code: 'task_not_running' });
    await expect(command(op('finish', stopped.task, first.callerTurnId))).rejects.toMatchObject({ code: 'task_not_running' });
    const ending = await run((state, current) => beginEnding(state, current, { expectedStateRevision: 1, reason: 'caller_ended' }));
    await run((state, current) => finishTerminal(state, current, { expectedStateRevision: ending.stateRevision, reason: 'caller_ended' }));
    await run((state, current) => forceTerminal(state, current, 'caller_ended'));
    const state = await saved();
    expect(state.outcomes[demo.id]).toHaveLength(1);
    expect(state.outcomes[demo.id][0]).toMatchObject({ kind: 'service_request', receiptId: null, endedBecause: 'caller_ended', reviewStatus: 'needs_review',
      missingFields: ['contactPhone', 'contactEmail', 'propertyCity'], fields: { callerName: 'Pat', serviceNeed: 'Roof cleaning' } });
    expect(state.workflows[demo.id].currentTask.noteRecordId).toBe(state.outcomes[demo.id][0].recordId);
    expect(withNextStep(state.outcomes[demo.id][0]).nextStep).toBe("The caller didn't leave a way to reach them.");
  });

  it('notes a request the caller stopped and started again once, from the later task', async () => {
    const first = await turn('I need my windows washed. Actually, never mind.');
    const stopped = await start(first.callerTurnId, 'service_request', 'Window washing');
    await record(stopped.task, first.callerTurnId, { callerName: 'Pat', serviceNeed: 'Window washing' });
    await command(op('cancel', stopped.task, first.callerTurnId));
    const again = await turn('Wait, yes, I do want the windows done. My number is 408-555-2147.');
    const restarted = await start(again.callerTurnId, 'service_request', 'Window washing');
    expect(restarted.task.taskId).not.toBe(stopped.task.taskId);
    await record(restarted.task, again.callerTurnId, { callerName: 'Pat', serviceNeed: 'Window washing', contactPhone: '4085552147' });
    await run((state, current) => forceTerminal(state, current, 'caller_ended'));
    const notes = (await saved()).outcomes[demo.id];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ taskId: restarted.task.taskId, missingFields: ['phoneConfirmed', 'propertyCity'] });
  });

  it('VA-T5: a caller who hangs up after name and phone leaves a note to ask where the job is', async () => {
    const first = await turn('This is Tom Lam, 408-555-2147, I need my driveway washed.');
    const result = await start(first.callerTurnId);
    await record(result.task, first.callerTurnId, { callerName: 'Tom Lam', contactPhone: '408-555-2147', serviceNeed: 'Driveway washing' });
    await run((state, current) => forceTerminal(state, current, 'hard_end_elapsed'));
    const note = withNextStep((await saved()).outcomes[demo.id][0]);
    expect(note).toMatchObject({ missingFields: ['phoneConfirmed', 'propertyCity'], endedBecause: 'hard_end_elapsed', reviewStatus: 'needs_review' });
    expect(note.nextStep).toBe('Call Tom at (408) 555-2147 to ask where the job is.');
    validateContract('boundary.schema.json#/$defs/requestRecord', note);
    expect((await saved()).workflows[demo.id].currentTask.status).toBe('stopped');
  });

  it('VA-T8: a person request during an open request leaves one note, and the escalation receipt points at it', async () => {
    const first = await turn('This is Ana, my number is 4085552147, I need pool cleaning.');
    let result = await start(first.callerTurnId);
    result = await record(result.task, first.callerTurnId, { callerName: 'Ana', contactPhone: '4085552147' });
    const human = await turn('Can I talk to a person?');
    const input = { callerTurnId: human.callerTurnId, expectedStateRevision: 1, expectedWorkflowRevision: result.workflowRevision, reason: 'human_preference' };
    const ended = await run((state, current) => taskEnd(state, current, input));
    expect(ended).toMatchObject({ status: 'ending', reason: 'human_preference' });
    expect(await run((state, current) => taskEnd(state, current, input))).toEqual(ended);
    const escalation = await run((state, current) => saveCase(state, current, { operationId: randomUUID(),
      expectedWorkflowRevision: ended.workflowRevision, reason: 'human_preference',
      context: { summary: 'Caller asked for a person.', callerTurnIds: [human.callerTurnId] } }, true));
    expect(escalation).toMatchObject({ operationKind: 'escalation', outcome: 'saved' });
    await run((state, current) => finishTerminal(state, current, { expectedStateRevision: ended.stateRevision, reason: 'human_preference' }));
    const state = await saved();
    expect(state.outcomes[demo.id]).toHaveLength(1);
    const note = withNextStep(state.outcomes[demo.id][0]);
    expect(note).toMatchObject({ endedBecause: 'human_preference', fields: { callerName: 'Ana', contactPhone: '(408) 555-2147' } });
    expect(note.nextStep).toBe('Call Ana back at (408) 555-2147. They asked to talk to a person.');
    expect(escalation.recordId).toBe(note.recordId);
    expect(state.cases[demo.id] ?? []).toHaveLength(0);
  });

  it('VA-T8: a person request with no open request is its own escalation note', async () => {
    const human = await turn('Can I talk to a person?');
    const input = { callerTurnId: human.callerTurnId, expectedStateRevision: 1, expectedWorkflowRevision: human.workflowRevision ?? 1, reason: 'human_preference' };
    const ended = await run((state, current) => taskEnd(state, current, input));
    await run((state, current) => saveCase(state, current, { operationId: randomUUID(),
      expectedWorkflowRevision: ended.workflowRevision, reason: 'human_preference',
      context: { summary: 'Caller asked for a person.', callerTurnIds: [human.callerTurnId] } }, true));
    const [escalationRecord] = (await saved()).cases[demo.id];
    expect(escalationRecord).toMatchObject({ kind: 'escalation', reviewStatus: 'needs_review', endedBecause: 'human_preference', missingFields: ['callerName', 'contactPhone', 'contactEmail'] });
    validateContract('boundary.schema.json#/$defs/caseRecord', withNextStep(escalationRecord));
    expect(withNextStep(escalationRecord).nextStep).toBe("The caller didn't leave a way to reach them.");
  });

  it('notes a task that only has a goal, skips a saved one, and files a complaint note under cases', async () => {
    const first = await turn('I want to complain about a missed visit.');
    const complaint = await start(first.callerTurnId, 'complaint', 'Complaint about a missed visit');
    await command(op('cancel', complaint.task, first.callerTurnId));
    const second = await turn('Also, I need my deck washed.');
    let result = await start(second.callerTurnId);
    result = await record(result.task, second.callerTurnId, { callerName: 'Lee', serviceNeed: 'Deck washing', contactPhone: '4085552147', phoneConfirmed: true, propertyCity: 'Irvine', cityConfirmed: true });
    expect(result.task.status).toBe('succeeded');
    const third = await turn('And can you move my appointment?');
    await start(third.callerTurnId, 'appointment_lookup', 'Change an appointment');
    await run((state, current) => forceTerminal(state, current, 'provider_failure'));
    const state = await saved();
    expect(state.outcomes[demo.id].map((item) => [item.kind, item.endedBecause])).toEqual([['service_request', null], ['appointment_lookup', 'provider_failure']]);
    expect(state.cases[demo.id]).toHaveLength(1);
    const note = state.cases[demo.id][0];
    expect(note).toMatchObject({ kind: 'complaint', endedBecause: 'provider_failure', receiptId: null, context: { summary: 'Complaint about a missed visit', callerTurnIds: [first.callerTurnId] } });
    validateContract('boundary.schema.json#/$defs/caseRecord', withNextStep(note));
  });

  it('finishes a complaint with a summary and no contact into one receipted case', async () => {
    const first = await turn('Your crew left a mess in my yard.');
    let result = await start(first.callerTurnId, 'complaint', 'Complaint about a messy yard');
    const early = op('finish', result.task, first.callerTurnId);
    await expect(command(early)).rejects.toMatchObject({ code: 'task_incomplete' });
    result = await record(result.task, first.callerTurnId, { summary: 'The crew left debris in the yard.', noContact: true });
    expect(result.task.missingFields).toEqual(['callerName']);
    const finish = op('finish', result.task, first.callerTurnId);
    const done = await command(finish);
    validateContract('task.schema.json#/$defs/response', done);
    expect(done.task).toMatchObject({ status: 'succeeded', receipt: { operationKind: 'case', outcome: 'saved' } });
    expect(await command(finish)).toEqual(done);
    const [saved_] = (await saved()).cases[demo.id];
    expect(saved_).toMatchObject({ kind: 'complaint', reviewStatus: 'needs_review', fields: { noContact: true }, context: { summary: 'The crew left debris in the yard.' } });
    validateContract('boundary.schema.json#/$defs/caseRecord', withNextStep(saved_));
  });

  it('refuses finish for a service request', async () => {
    const first = await turn('I need my driveway washed.');
    const result = await start(first.callerTurnId);
    await expect(command(op('finish', result.task, first.callerTurnId))).rejects.toMatchObject({ code: 'finish_not_allowed' });
  });

  it('runs an appointment lookup on finish and keeps not_found apart from unavailable', async () => {
    const first = await turn('Please reschedule my appointment.');
    let result = await start(first.callerTurnId, 'appointment_lookup', 'Reschedule an appointment');
    await expect(command(op('finish', result.task, first.callerTurnId))).rejects.toMatchObject({ code: 'task_incomplete' });
    result = await record(result.task, first.callerTurnId, { callerName: 'Sam', appointmentAction: 'reschedule', contactPhone: '4085552147' });
    result = await command(op('finish', result.task, first.callerTurnId));
    expect(result.task).toMatchObject({ status: 'succeeded', lookup: { kind: 'not_found' } });
    const second = await turn('Please cancel another one.');
    let other = await start(second.callerTurnId, 'appointment_lookup', 'Cancel an appointment');
    other = await record(other.task, second.callerTurnId, { callerName: 'Pat', appointmentAction: 'cancel' });
    other = await command(op('finish', other.task, second.callerTurnId), { lookupFailureReason: () => 'storage_error' });
    expect(other.task).toMatchObject({ status: 'succeeded', lookup: { kind: 'unavailable', reason: 'storage_error' } });
    const state = await saved();
    expect(Object.values(state.lookups)).toHaveLength(2);
    const notes = state.outcomes[demo.id];
    expect(notes.map((item) => item.lookup.kind)).toEqual(['not_found', 'unavailable']);
    expect(withNextStep(notes[0]).nextStep).toBe('Call Sam at (408) 555-2147 about changing their appointment.');
    notes.forEach((item) => validateContract('boundary.schema.json#/$defs/requestRecord', withNextStep(item)));
    await run((state_, current) => forceTerminal(state_, current, 'caller_ended'));
    expect((await saved()).outcomes[demo.id]).toHaveLength(2);
  });

  it('closes a Frontline Q&A human request without business writes', async () => {
    await store.transaction((state) => { state.demos[demo.id].mode = 'frontline_qa'; state.demos[demo.id].agentVersionId = null; });
    const human = await turn('I want a person.');
    const ending = await run((state, current) => taskEnd(state, current, { callerTurnId: human.callerTurnId,
      expectedStateRevision: 1, expectedWorkflowRevision: 1, reason: 'human_preference' }));
    expect(ending).toMatchObject({ status: 'ending', reason: 'human_preference' });
    expect((await saved()).cases[demo.id]).toBeUndefined();
    expect((await saved()).outcomes[demo.id]).toBeUndefined();
  });

  it('rejects task changes once the call is ending', async () => {
    const first = await turn('I need my driveway washed.');
    const result = await start(first.callerTurnId);
    await run((state, current) => beginEnding(state, current, { expectedStateRevision: 1, reason: 'caller_ended' }));
    await expect(record(result.task, first.callerTurnId, { callerName: 'Sam' })).rejects.toMatchObject({ code: 'session_ending' });
  });
});
