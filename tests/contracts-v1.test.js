import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { assertSessionMutable, DEADLINES_SECONDS, validateConfirmationBinding, validateLookupResult, validateReceipt, validateTerminalSession, validateWorkflowState, WORKFLOW_IDS } from '../contracts/v1/contract-validator.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash = 'a'.repeat(64);

describe('TOM-19 frozen workflow contracts', () => {
  it('ships parseable JSON schemas and endpoint/workflow manifests', async () => {
    for (const name of await readdir('contracts/v1/schemas')) JSON.parse(await readFile(`contracts/v1/schemas/${name}`, 'utf8'));
    JSON.parse(await readFile('contracts/v1/http-endpoints.json', 'utf8'));
  });
  it('covers all six workflows with only their allowed tools', () => {
    expect(WORKFLOW_IDS).toEqual(['WF-01','WF-02','WF-03','WF-04','WF-05','WF-06']);
    const tools = { 'WF-01':['retrieve_facts'], 'WF-02':['list_services'], 'WF-03':['save_request'], 'WF-04':['lookup_appointment'], 'WF-05':['save_case'], 'WF-06':['record_escalation','end_session'] };
    for (const [workflowId, allowedToolIds] of Object.entries(tools)) expect(validateWorkflowState({workflowInstanceId:id(1),workflowId,phase:'collecting',revision:1,allowedToolIds})).toBeTruthy();
    expect(() => validateWorkflowState({workflowInstanceId:id(1),workflowId:'WF-01',phase:'collecting',revision:1,allowedToolIds:['save_request']})).toThrow(/not allowed/);
  });
  it('freezes setup, soft-close, and hard-end seconds', () => expect(DEADLINES_SECONDS).toEqual({setup:20,softClose:270,hardEnd:300}));
  it('accepts only the current server-bound confirmation', () => {
    const binding = {confirmationId:id(2),workflowInstanceId:id(1),callerTurnId:id(3),callerTurnSequence:7,fieldRevision:4,readbackRevision:4,readbackPayloadHash:hash,serverRecordedAt:'2026-09-24T00:00:00Z',dialogueAct:'affirm',workflowRevision:5};
    const current = {workflowInstanceId:id(1),latestCallerTurnId:id(3),latestCallerTurnSequence:7,latestCallerDialogueAct:'affirm',latestCallerClassificationStatus:'classified',readbackAfterCallerTurnSequence:6,fieldRevision:4,readbackRevision:4,readbackPayloadHash:hash};
    expect(validateConfirmationBinding(binding,current)).toBe(binding);
    expect(() => validateConfirmationBinding({...binding,callerTurnSequence:6},current)).toThrow('stale_or_forged_confirmation');
    expect(() => validateConfirmationBinding({...binding,fieldRevision:3},current)).toThrow('stale_or_forged_confirmation');
    expect(() => validateConfirmationBinding({...binding,readbackPayloadHash:'b'.repeat(64)},current)).toThrow('stale_or_forged_confirmation');
  });
  it('distinguishes no match, verification, and lookup failure', () => {
    expect(validateLookupResult({kind:'not_found',lookupId:id(5),workflowRevision:1}).kind).toBe('not_found');
    expect(validateLookupResult({kind:'verification_required',lookupId:id(5),workflowRevision:1}).kind).toBe('verification_required');
    expect(validateLookupResult({kind:'unavailable',lookupId:id(5),workflowRevision:1,reason:'timeout'}).kind).toBe('unavailable');
    expect(() => validateLookupResult({kind:'not_found',lookupId:id(5),workflowRevision:1,reason:'timeout'})).toThrow();
    expect(() => validateLookupResult({kind:'unavailable',lookupId:id(5),workflowRevision:1})).toThrow();
  });
  it('requires truthful append-only receipt outcomes', () => {
    const base = {receiptId:id(7),operationId:id(8),operationKind:'request',payloadHash:hash,workflowInstanceId:id(1),workflowRevision:5,recordedAt:'2026-09-24T00:00:00Z',sequence:1};
    expect(validateReceipt({...base,outcome:'saved',recordId:id(9)}).outcome).toBe('saved');
    expect(validateReceipt({...base,outcome:'failed',failureCode:'storage_error'}).outcome).toBe('failed');
    expect(() => validateReceipt({...base,outcome:'saved'})).toThrow(/recordId/);
  });
  it('rejects mutation after ending/terminal and freezes terminal reason', () => {
    expect(() => assertSessionMutable({phase:'ending'})).toThrow('terminal_session_immutable');
    expect(() => assertSessionMutable({status:'terminal'})).toThrow('terminal_session_immutable');
    expect(validateTerminalSession({sessionId:id(1),status:'terminal',reason:'human_preference',stateRevision:8,workflowRevision:8,terminalAt:'2026-09-24T00:00:00Z',reconnectAllowed:false}).reason).toBe('human_preference');
    expect(() => validateTerminalSession({sessionId:id(1),status:'terminal',reason:'human_preference',stateRevision:8,workflowRevision:8,terminalAt:'2026-09-24T00:00:00Z',reconnectAllowed:true})).toThrow();
  });
});

it('validates shared positive and negative schema fixtures without coercion', async () => {
  const { validateContract } = await import('../contracts/v1/contract-validator.js');
  const fixtures = JSON.parse(await readFile('contracts/v1/fixtures.json', 'utf8'));
  for (const item of fixtures.cases) {
    if (item.valid) expect(validateContract(item.reference, item.value), item.name).toEqual(item.value);
    else expect(() => validateContract(item.reference, item.value), item.name).toThrow();
  }
});

it('rejects mismatched turn IDs, negative/corrected replies and turns before readback across JS and TS', async () => {
  const { confirmationAuthorizesWrite } = await import('../contracts/v1/typescript/index');
  const { binding, current } = JSON.parse(await readFile('contracts/v1/fixtures.json', 'utf8')).confirmation;
  expect(confirmationAuthorizesWrite(binding, current)).toBe(true);
  for (const [key, value] of [
    ['latestCallerTurnId', id(90)], ['latestCallerDialogueAct', 'negate'], ['latestCallerDialogueAct', 'correct'],
    ['latestCallerClassificationStatus', 'unavailable'], ['readbackAfterCallerTurnSequence', 7], ['fieldRevision', 9],
  ]) {
    expect(() => validateConfirmationBinding(binding, { ...current, [key]: value })).toThrow('stale_or_forged_confirmation');
    expect(confirmationAuthorizesWrite(binding, { ...current, [key]: value })).toBe(false);
  }
});

it('fails closed for unknown or incomplete state across JS and TS', async () => {
  const { mayMutateSession } = await import('../contracts/v1/typescript/index');
  const fixtures = JSON.parse(await readFile('contracts/v1/fixtures.json', 'utf8'));
  for (const item of fixtures.cases.filter(({ name }) => name.startsWith('session guard'))) {
    expect(mayMutateSession(item.value), item.name).toBe(item.valid);
    if (item.valid) expect(assertSessionMutable(item.value)).toBe(item.value);
    else expect(() => assertSessionMutable(item.value)).toThrow('terminal_session_immutable');
  }
});

it('freezes concrete schema references for every route and maps every workflow tool', async () => {
  const endpoints = JSON.parse(await readFile('contracts/v1/http-endpoints.json', 'utf8')).endpoints;
  for (const endpoint of endpoints) for (const side of ['request', 'response']) {
    const [file, fragment] = endpoint[side].$ref.split('#');
    let schema = JSON.parse(await readFile(`contracts/v1/${file}`, 'utf8'));
    for (const key of (fragment || '').split('/').filter(Boolean)) schema = schema?.[key];
    expect(schema, `${endpoint.path} ${side}`).toBeTruthy();
  }
  const workflows = JSON.parse(await readFile('contracts/v1/workflows.json', 'utf8')).workflows;
  const mapped = new Set(endpoints.flatMap(({ toolIds }) => toolIds));
  for (const tool of workflows.flatMap(({ allowedTools }) => allowedTools)) expect(mapped.has(tool)).toBe(true);
  expect(endpoints.some(({ path }) => path === '/v1/internal/demos/{demoId}/turn')).toBe(true);
  expect(endpoints.filter(({ path }) => path.endsWith('/history')).every(({ auth }) => auth === 'owner_membership')).toBe(true);
});

it('returns CAS workflow revisions after every action needed for the next worker call', async () => {
  const boundary = JSON.parse(await readFile('contracts/v1/schemas/boundary.schema.json', 'utf8')).$defs;
  for (const name of ['finalizedCallerTurn', 'fieldValidation', 'readback', 'endingSession']) {
    expect(boundary[name].required, name).toContain('workflowRevision');
    expect(boundary[name].properties.workflowRevision.minimum).toBe(1);
  }
  for (const file of ['confirmation', 'receipt', 'appointment-lookup', 'session-terminal']) {
    const schema = JSON.parse(await readFile(`contracts/v1/schemas/${file}.schema.json`, 'utf8'));
    for (const variant of schema.oneOf || [schema]) expect(variant.required, file).toContain('workflowRevision');
  }
  expect(boundary.confirmationInput.required).toContain('expectedWorkflowRevision');
  const endpoints = JSON.parse(await readFile('contracts/v1/http-endpoints.json', 'utf8')).endpoints;
  expect(endpoints.find(({ path }) => path === '/v1/demos/{demoId}/result').response.$ref).toContain('demoResultResponse');
});
