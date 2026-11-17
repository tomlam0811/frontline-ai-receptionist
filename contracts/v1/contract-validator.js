import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractRoot = dirname(fileURLToPath(import.meta.url));
const schemas = new Map();
export const workflowContract = JSON.parse(readFileSync(join(contractRoot, 'workflows.json'), 'utf8'));
export const DEADLINES_SECONDS = Object.freeze({ ...workflowContract.deadlinesSeconds });
export const WORKFLOW_IDS = Object.freeze(workflowContract.workflows.map(({ id }) => id));
const workflowMap = new Map(workflowContract.workflows.map(({ id, allowedTools }) => [id, new Set(allowedTools)]));

function resolve(reference, base = 'boundary.schema.json') {
  const [file, fragment] = reference.split('#');
  const name = file ? file.split('/').at(-1) : base;
  if (!schemas.has(name)) schemas.set(name, JSON.parse(readFileSync(join(contractRoot, 'schemas', name), 'utf8')));
  let schema = schemas.get(name);
  for (const key of (fragment || '').split('/').filter(Boolean)) schema = schema?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (!schema) throw new TypeError(`Unknown schema reference ${reference}`);
  return { schema, name };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
function check(schema, value, file, path) {
  if (schema.$ref) { const target = resolve(schema.$ref, file); check(target.schema, value, target.name, path); }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!schema[keyword]) continue;
    let count = 0;
    const errors = [];
    for (const branch of schema[keyword]) {
      try { check(branch, value, file, path); count += 1; } catch (error) { errors.push(error.message); }
    }
    if (!count || (keyword === 'oneOf' && count !== 1)) fail(path, `${keyword} failed (${errors.join('; ')})`);
  }
  if ('const' in schema && !equal(value, schema.const)) fail(path, 'invalid constant');
  if (schema.enum && !schema.enum.some((item) => equal(value, item))) fail(path, 'invalid enum');
  const types = schema.type ? [].concat(schema.type) : [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length && !types.some((type) => type === actual || (type === 'integer' && Number.isSafeInteger(value)))) fail(path, `expected ${types.join('|')}`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) fail(path, 'number out of range');
  }
  if (typeof value === 'string') {
    if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) fail(path, 'string length');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(path, 'pattern mismatch');
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(path, 'invalid UUID');
    if (schema.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) fail(path, 'invalid timestamp');
    if (schema.format === 'uri') { try { new URL(value); } catch { fail(path, 'invalid URI'); } }
  }
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail(path, 'array length');
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail(path, 'duplicate items');
    if (schema.items) value.forEach((item, index) => check(schema.items, item, file, `${path}[${index}]`));
  }
  if (actual === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(path, `${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) check(schema.properties[key], item, file, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(path, `unknown property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, item, file, `${path}.${key}`);
    }
  }
}
/** Validates the JSON Schema subset used by the frozen boundary; no coercion or defaults. */
export function validateContract(reference, value) {
  const { schema, name } = resolve(reference);
  check(schema, value, name, '$');
  return value;
}
export function validateWorkflowState(value) {
  validateContract('workflow.schema.json#/$defs/state', value);
  if (value.allowedToolIds.some((tool) => !workflowMap.get(value.workflowId).has(tool))) throw new TypeError('Tool is not allowed for workflow');
  if (['ending', 'terminal'].includes(value.phase) && value.allowedToolIds.some((tool) => !['record_escalation', 'end_session'].includes(tool))) throw new TypeError('Ending workflow cannot allow mutable intake tools');
  return value;
}
export function validateConfirmationBinding(binding, current) {
  validateContract('confirmation.schema.json', binding);
  validateContract('boundary.schema.json#/$defs/confirmationState', current);
  if (binding.workflowInstanceId !== current.workflowInstanceId || binding.callerTurnId !== current.latestCallerTurnId || binding.callerTurnSequence !== current.latestCallerTurnSequence || binding.fieldRevision !== current.fieldRevision || binding.readbackRevision !== current.readbackRevision || binding.readbackPayloadHash !== current.readbackPayloadHash || current.latestCallerDialogueAct !== 'affirm' || current.latestCallerClassificationStatus !== 'classified' || binding.callerTurnSequence <= current.readbackAfterCallerTurnSequence) throw new Error('stale_or_forged_confirmation');
  return binding;
}
export const validateLookupResult = (value) => validateContract('appointment-lookup.schema.json', value);
export const validateReceipt = (value) => validateContract('receipt.schema.json', value);
export const validateTerminalSession = (value) => validateContract('session-terminal.schema.json', value);
export function assertSessionMutable(session) {
  try { validateContract('boundary.schema.json#/$defs/sessionGuard', session); }
  catch { throw new Error('terminal_session_immutable'); }
  return session;
}
export function validateProfileRevision(value) {
  validateContract('profile-capability.schema.json', value);
  if (new Set(value.capabilities.map(({ workflowId }) => workflowId)).size !== WORKFLOW_IDS.length) throw new TypeError('Exactly one capability per workflow is required');
  for (const item of value.capabilities) if (item.allowedToolIds.some((tool) => !workflowMap.get(item.workflowId).has(tool)) || (!item.enabled && item.allowedToolIds.length)) throw new TypeError('Tool is not allowed for workflow');
  return value;
}
export function validateRetrievalResult(value) {
  validateContract('boundary.schema.json#/$defs/retrievalResult', value);
  const passageIds = new Set(value.passages.map(({ passageId }) => passageId));
  if (value.status === 'supported' ? !value.facts.length || value.facts.some((fact) => fact.eligibility !== 'eligible' || fact.passageIds.some((id) => !passageIds.has(id))) : value.facts.length > 0) throw new TypeError('Unsupported retrieval evidence');
  return value;
}
