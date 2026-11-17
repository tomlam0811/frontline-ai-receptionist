import { randomUUID } from 'node:crypto';

// Task fields and the owner records a task becomes (voice agent v2, VA-C1 and VA-D4). Shared by the task
// commands and every terminal path, so a saved request and a Needs review note are built the same way.

export const TASK_KINDS = Object.freeze(['service_request', 'appointment_lookup', 'complaint']);
// notes and company are in the v1 recordFields contract; Bob uses notes for who a caller is calling for and the property.
const TEXT_LIMITS = Object.freeze({ callerName: 200, serviceNeed: 500, propertyCity: 200, propertyState: 100, summary: 1000, company: 500, notes: 500 });
// phoneAsGiven: the caller repeated a number that fails the US pattern check, so it is kept as they said it.
const BOOLEAN_FIELDS = new Set(['cityConfirmed', 'phoneConfirmed', 'noContact', 'phoneAsGiven']);
export const TASK_FIELDS = Object.freeze([...Object.keys(TEXT_LIMITS), 'contactPhone', 'contactEmail', 'appointmentAction', ...BOOLEAN_FIELDS]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const nowIso = () => new Date().toISOString();

/** Ten digits as "(408) 555-2147", or null. */
export const phoneText = (digits) => (digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : null);

/**
 * A US phone number: 10 digits, or 11 starting with 1, once spaces, dashes, dots, slashes, parentheses and a plus are
 * removed. North American area codes and exchanges never start with 0 or 1, so a number like that was misheard.
 */
export function normalizePhone(value, { asGiven = false } = {}) {
  const digits = phoneDigits(value);
  if (!digits) return null;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) || (asGiven && digits.length === 10) ? phoneText(digits) : null;
}

function phoneDigits(value) {
  const stripped = String(value).trim().replace(/[\s().\-+/]/g, '');
  if (!/^\d+$/.test(stripped)) return null;
  return stripped.length === 11 && stripped.startsWith('1') ? stripped.slice(1) : stripped;
}

/**
 * Normalizes one recorded field. Returns {value} when accepted or {reason} (plain words) when rejected. phoneAsGiven
 * accepts any ten-digit number the caller repeated after the pattern check refused it.
 */
export function normalizeField(key, value, { phoneAsGiven = false } = {}) {
  if (!TASK_FIELDS.includes(key)) return { reason: "Blake can't record this detail." };
  if (BOOLEAN_FIELDS.has(key)) return typeof value === 'boolean' ? { value } : { reason: 'Send true or false.' };
  if (typeof value !== 'string') return { reason: 'Send this as words.' };
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return { reason: 'This was empty.' };
  if (key === 'contactPhone') {
    const phone = normalizePhone(text, { asGiven: phoneAsGiven });
    if (phone) return { value: phone };
    return phoneDigits(text)?.length === 10
      ? { reason: "That doesn't look like a working US number, because an area code or the next three digits never start with 0 or 1." }
      : { reason: "That isn't a complete US phone number." };
  }
  if (key === 'contactEmail') {
    const email = text.toLowerCase();
    return EMAIL.test(email) && email.length <= 254 ? { value: email } : { reason: "This doesn't look like an email address." };
  }
  if (key === 'appointmentAction') {
    const action = text.toLowerCase();
    return ['cancel', 'reschedule'].includes(action) ? { value: action } : { reason: 'Use cancel or reschedule.' };
  }
  if (text.length > TEXT_LIMITS[key]) return { reason: `Keep this under ${TEXT_LIMITS[key]} characters.` };
  if (key === 'callerName' && !/\p{L}/u.test(text)) return { reason: "This doesn't look like a name." };
  return { value: text };
}

/**
 * What the owner would still need, by kind. A service request is complete when this is empty. A complaint or an
 * appointment lookup can be saved without contact details, so these entries only describe the note. An appointment
 * never lists contact: the owner finds the caller through the appointment itself.
 * `escalation` is a case record kind, never a task kind.
 */
export function missingFieldsFor(kind, fields = {}) {
  const missing = [];
  const contact = Boolean(fields.contactPhone || fields.contactEmail);
  if (kind === 'service_request') {
    if (!fields.callerName) missing.push('callerName');
    if (!fields.serviceNeed) missing.push('serviceNeed');
    if (!contact) missing.push('contactPhone', 'contactEmail');
    // A phone number counts once the caller has confirmed the number read back to them.
    if (fields.contactPhone && fields.phoneConfirmed !== true) missing.push('phoneConfirmed');
    if (!fields.propertyCity) missing.push('propertyCity');
    else if (!fields.propertyState && fields.cityConfirmed !== true) missing.push('propertyState');
    return missing;
  }
  if (kind === 'complaint' && !fields.summary) missing.push('summary');
  if (!fields.callerName) missing.push('callerName');
  if (kind === 'appointment_lookup' && !fields.appointmentAction) missing.push('appointmentAction');
  if (!contact && kind !== 'appointment_lookup' && !(kind === 'complaint' && fields.noContact === true)) missing.push('contactPhone', 'contactEmail');
  return missing;
}

/** Builds the owner record for a task: a case for a complaint, a request outcome otherwise. Not stored yet. */
export function buildTaskRecord(state, demo, workflow, task, extra = {}) {
  const fields = structuredClone(task.fields ?? {});
  const common = { recordId: randomUUID(), demoId: demo.id, workflowInstanceId: workflow.workflowInstanceId, kind: task.kind,
    taskId: task.taskId, goal: task.goal, fields, receiptId: null, savedAt: nowIso(), deliveryState: 'not_sent',
    reviewStatus: 'needs_review', reviewedAt: null, missingFields: missingFieldsFor(task.kind, fields), endedBecause: null };
  if (task.kind === 'complaint') {
    const callerTurnIds = [...new Set((task.evidenceTurns ?? []).map((item) => item.callerTurnId))].slice(-50);
    const context = { summary: fields.summary ?? task.goal, callerTurnIds };
    for (const key of ['callerName', 'contactPhone', 'contactEmail']) if (fields[key]) context[key] = fields[key];
    return { ...common, context, escalationReason: null, ...extra };
  }
  return { ...common, knowledgeRevisionId: demo.knowledgeRevisionId,
    profileRevisionId: state.preparations?.[demo.preparationId]?.profileRevisionId ?? demo.knowledgeRevisionId,
    agentVersionId: demo.agentVersionId, confirmation: null, bookingState: 'not_booked', ...(task.kind === 'appointment_lookup' ? { lookup: null } : {}), ...extra };
}

/** Stores a built record in outcomes or cases and links it to the task, so no path notes the task twice. */
export function storeTaskRecord(state, demo, task, record) {
  const list = task.kind === 'complaint' ? (state.cases ??= {}) : (state.outcomes ??= {});
  (list[demo.id] ??= []).push(record);
  task.noteRecordId = record.recordId;
  return record;
}

/** Copies a saved task's current fields onto the record it was saved as, so the owner sees the caller's latest details. */
export function updateTaskRecord(state, demo, task) {
  const list = task.kind === 'complaint' ? state.cases?.[demo.id] : state.outcomes?.[demo.id];
  const record = (list ?? []).find((item) => item.recordId === task.noteRecordId);
  if (!record) return null;
  record.fields = structuredClone(task.fields ?? {});
  record.missingFields = missingFieldsFor(task.kind, record.fields);
  return record;
}

/**
 * VA-D4: on any terminal path, every task of the call that did not finish becomes one Needs review note with what
 * was collected. Idempotent through task.noteRecordId. Legacy-v1 calls have no tasks, so nothing happens for them.
 */
export function noteOpenTasks(state, demo, reason) {
  const workflow = state.workflows?.[demo.id];
  if (!workflow) return;
  const tasks = [...Object.values(workflow.priorTasks ?? {}), workflow.currentTask].filter(Boolean);
  for (const [index, task] of tasks.entries()) {
    if (task.noteRecordId || task.status === 'succeeded' || !TASK_KINDS.includes(task.kind)) continue;
    // A request the caller stopped and then started again is one request: only the later task speaks for it.
    if (task.status === 'stopped' && tasks.slice(index + 1).some((later) => later.kind === task.kind)) continue;
    if (!task.goal && !Object.keys(task.fields ?? {}).length) continue;
    if (task.status !== 'failed') task.status = 'stopped';
    task.missingFields = missingFieldsFor(task.kind, task.fields ?? {});
    storeTaskRecord(state, demo, task, buildTaskRecord(state, demo, workflow, task, { endedBecause: reason ?? null }));
  }
}
