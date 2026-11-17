import { missingFieldsFor, phoneText } from './task-records.js';

// VA-D5: the owner's next step for a Needs review note. Code builds it from what is known, never a model, and it
// is computed when a record is read, so a wording change applies to old notes too.

const CASE_KINDS = new Set(['complaint', 'escalation']);
// Asks in the order the line reads them. A city without a confirmed state is still "where the job is".
const ASKS = [['serviceNeed', 'what they need'], ['propertyCity', 'where the job is'], ['propertyState', 'where the job is']];

/** A stored phone as "(408) 555-2147" when it has 10 digits (or 11 starting with 1), otherwise as written. */
export function formatPhone(value) {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  return phoneText(digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits) ?? value.trim();
}

// The sentence the voice worker writes into a request's notes when the caller asked to talk to the owner.
export const ASKED_FOR_OWNER = 'Asked to talk to the owner.';
// The sentence it writes when the caller said they need the work soon.
export const WANTS_IT_SOON = 'Wants it done as soon as possible.';

const firstName = (name) => (typeof name === 'string' ? name.trim().split(/\s+/)[0] : '');

// An appointment change is found by the caller's name, so it needs no phone or email.
const APPOINTMENT_STEPS = { cancel: 'and cancel it', reschedule: 'and call them about a new time' };
function appointmentStep(fields) {
  const name = typeof fields.callerName === 'string' ? fields.callerName.trim() : '';
  if (!name) return "The caller didn't say whose appointment it is.";
  return `Look up ${name}'s appointment ${APPOINTMENT_STEPS[fields.appointmentAction] ?? 'to see what they need'}.`;
}

/**
 * One line telling the owner what to do. Pure.
 * @param {{kind?: string, fields?: Record<string, any>, missingFields?: string[], endedBecause?: string | null, escalationReason?: string | null}} note
 */
export function nextStep({ kind = 'service_request', fields = {}, missingFields = [], endedBecause = null, escalationReason = null }) {
  const phone = formatPhone(fields.contactPhone);
  const email = typeof fields.contactEmail === 'string' ? fields.contactEmail.trim() : '';
  if (!phone && !email && kind === 'appointment_lookup') return appointmentStep(fields);
  if (!phone && !email) return "The caller didn't leave a way to reach them.";
  const name = firstName(fields.callerName);
  // Bob keeps the call going when someone asks for a person and adds this sentence to their request's notes instead.
  const askedForOwner = typeof fields.notes === 'string' && fields.notes.includes(ASKED_FOR_OWNER);
  if (endedBecause === 'human_preference' || escalationReason === 'human_preference' || askedForOwner) {
    return phone ? `Call ${name || 'them'} back at ${phone}. They asked to talk to a person.`
      : `Email ${name ? `${name} at ` : ''}${email}. They asked to talk to a person.`;
  }
  const reach = phone ? `Call ${name ? `${name} at ` : ''}${phone}` : `Email ${name ? `${name} at ` : ''}${email}`;
  if (kind === 'complaint') return `${reach} about their complaint.`;
  if (kind === 'appointment_lookup') return `${reach} about changing their appointment.`;
  const asks = [...new Set(ASKS.filter(([key]) => missingFields.includes(key)).map(([, ask]) => ask))];
  const soon = typeof fields.notes === 'string' && fields.notes.includes(WANTS_IT_SOON) ? ' They want it done as soon as possible.' : '';
  return `${asks.length ? `${reach} to ask ${asks.join(' and ')}.` : `${reach} to follow up.`}${soon}`;
}

/**
 * A stored request, case or escalation record as the owner reads it: review status (default needs_review),
 * missing fields (computed for records saved before notes existed) and the next step.
 */
export function withNextStep(record) {
  const isCase = CASE_KINDS.has(record?.kind);
  const kind = record?.kind ?? 'service_request';
  const fields = record?.fields ?? (isCase ? Object.fromEntries(['callerName', 'contactPhone', 'contactEmail', 'summary']
    .filter((key) => record?.context?.[key]).map((key) => [key, record.context[key]])) : {});
  // Records saved before notes existed carry no missingFields. They never collected a state or confirmed a phone
  // number, so neither is missing.
  const missingFields = Array.isArray(record?.missingFields) ? record.missingFields
    : missingFieldsFor(kind, fields).filter((key) => key !== 'propertyState' && key !== 'phoneConfirmed');
  const endedBecause = record?.endedBecause ?? null;
  return { ...record, reviewStatus: record?.reviewStatus ?? 'needs_review', missingFields, endedBecause,
    nextStep: nextStep({ kind, fields, missingFields, endedBecause, escalationReason: record?.escalationReason ?? null }) };
}

export const withNextSteps = (records) => (Array.isArray(records) ? records.map(withNextStep) : []);
