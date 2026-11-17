import test from 'node:test';
import assert from 'node:assert/strict';
import { DEADLINES_SECONDS, validateConfirmationBinding } from '../contracts/v1/contract-validator.js';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('contract constants and authoritative confirmation binding', () => {
  assert.deepEqual(DEADLINES_SECONDS,{setup:20,softClose:270,hardEnd:300});
  const binding={confirmationId:id(1),workflowInstanceId:id(2),callerTurnId:id(3),callerTurnSequence:2,fieldRevision:4,readbackRevision:4,readbackPayloadHash:'a'.repeat(64),serverRecordedAt:'2026-09-24T00:00:00Z',dialogueAct:'affirm',workflowRevision:5};
  assert.throws(() => validateConfirmationBinding(binding,{workflowInstanceId:id(2),latestCallerTurnId:id(3),latestCallerTurnSequence:2,latestCallerDialogueAct:'affirm',latestCallerClassificationStatus:'classified',readbackAfterCallerTurnSequence:1,fieldRevision:5,readbackRevision:4,readbackPayloadHash:'a'.repeat(64)}),/stale_or_forged/);
});
