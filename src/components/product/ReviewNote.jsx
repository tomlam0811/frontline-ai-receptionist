import './call-summary.css';
import { useId } from 'react';

// VA-D4, VA-D5. A Needs review note: one thing the customer asked for that the receptionist could not finish on the call.
// Shared by the conversation Outcomes list (with Mark as done) and the call result (status only).

export const FIELDS = [
  ['callerName', 'Name'], ['contactPhone', 'Phone'], ['contactEmail', 'Email'], ['serviceNeed', 'Service need'],
  ['propertyCity', 'Property city'], ['propertyType', 'Property type'], ['company', 'Company'],
  ['preferredDay', 'Preferred day'], ['preferredWindow', 'Preferred window'], ['timezone', 'Time zone'],
  ['recurrence', 'Recurrence'], ['notes', 'Notes'],
];

// Missing details in the words an owner would use. Keys that share a phrase are said once.
const MISSING_WORDS = {
  propertyCity: 'where the job is', propertyState: 'where the job is', serviceNeed: 'what they need',
  callerName: 'their name', contactPhone: 'a way to reach them', contactEmail: 'a way to reach them',
  phoneConfirmed: 'a confirmed phone number',
  summary: 'what happened', appointmentAction: 'whether to cancel or change it',
};

const APPOINTMENT_TITLES = { cancel: 'Cancel an appointment', reschedule: 'Change an appointment' };

/** The details of a request (`fields`), case (`context`) or call task (`fields`), as one object. */
export const noteValues = (item) => ({ ...(item?.context ?? {}), ...(item?.fields ?? {}) });

/** What the customer asked for. `kind` is the record or task kind; unknown kinds fall back to the details. */
export function noteTitle(item) {
  const values = noteValues(item);
  if (item?.kind === 'appointment_lookup') {
    const action = values.appointmentAction ?? item.appointmentAction ?? item.action;
    if (APPOINTMENT_TITLES[action]) return APPOINTMENT_TITLES[action];
  }
  if (item?.kind === 'escalation' && [item.escalationReason, item.endedBecause].includes('human_preference')) return 'Talk to a person';
  return values.serviceNeed || values.summary || item?.goal || 'Customer request';
}

/** "where the job is and a way to reach them", or '' when nothing the owner would recognize is missing. */
export function missingText(keys) {
  if (!Array.isArray(keys)) return '';
  const words = [...new Set(keys.map((key) => MISSING_WORDS[key] ?? FIELDS.find(([name]) => name === key)?.[1].toLowerCase()).filter(Boolean))];
  return words.length ? new Intl.ListFormat('en', { type: 'conjunction' }).format(words) : '';
}

function Details({ values, skip, className }) {
  const shown = FIELDS.filter(([key]) => key !== skip && values[key]);
  if (!shown.length) return null;
  const show = (key) => key === 'propertyCity' && values.propertyState ? `${values.propertyCity}, ${values.propertyState}` : values[key];
  return <dl className={className}>{shown.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{show(key)}</dd></div>)}</dl>;
}

/**
 * @param {{item: any, status?: 'needs_review'|'done', variant?: 'history'|'outcome', audience?: 'owner'|'caller', businessName?: string|null, children?: any, key?: any}} props
 * `item` is a request record, case record or call task. `children` holds the one action, when there is one.
 * The caller audience (a shared-link guest) sees what they asked for and who has it, never the owner's review details.
 */
export default function ReviewNote({ item, status = item?.reviewStatus === 'done' ? 'done' : 'needs_review', variant = 'history', audience = 'owner', businessName = null, children = null }) {
  const titleId = useId();
  const values = noteValues(item);
  const title = noteTitle(item);
  const missing = missingText(item?.missingFields);
  const done = status === 'done';
  const card = variant === 'outcome' ? 'outcome-card' : 'history-card';
  if (audience === 'caller') return <article className={`${card} review-note`} aria-labelledby={titleId}>
    <p className={`${card}__label`}>Your request</p>
    <h3 id={titleId}>{title}</h3>
    <Details values={values} skip={values.serviceNeed === title ? 'serviceNeed' : null} className={variant === 'outcome' ? 'bob-result__fields' : undefined} />
    <p className="review-note__quiet">{`Passed along to ${businessName ?? 'the business'}.${item?.kind === 'service_request' ? ' Nothing is booked yet.' : ''}`}</p>
  </article>;
  return <article className={`${card} review-note${done ? ' review-note--done' : ''}`} aria-labelledby={titleId}>
    <p className={`${card}__label`} aria-live="polite">{done ? 'Done' : 'Needs review'}</p>
    <h3 id={titleId}>{title}</h3>
    <Details values={values} skip={values.serviceNeed === title ? 'serviceNeed' : null} className={variant === 'outcome' ? 'bob-result__fields' : undefined} />
    {missing && <p className="review-note__missing">Missing: {missing}.</p>}
    {item?.nextStep && <p className="review-note__next"><strong>Next step:</strong> {item.nextStep}</p>}
    <p className="review-note__quiet">Nothing was booked or sent.</p>
    {children}
  </article>;
}

const recordKind = (record, list) => list === 'requests' ? (record.kind === 'appointment_lookup' ? 'appointment_lookup' : record.kind ?? 'service_request') : record.kind ?? 'case';
// The record kind each call task becomes. Escalations have no task of their own.
const TASK_RECORD_KIND = { service_request: 'service_request', appointment_lookup: 'appointment_lookup', complaint: 'complaint' };

/** Request and case records as one list, each with the kind used to pair it with a call task. */
export function recordNotes(records) {
  const requests = Array.isArray(records?.requests) ? records.requests : [];
  const cases = Array.isArray(records?.cases) ? records.cases : [];
  return [...requests.map((record) => ({ ...record, kind: recordKind(record, 'requests') })), ...cases.map((record) => ({ ...record, kind: recordKind(record, 'cases') }))];
}

/**
 * The call tasks that no record stands for, so the same request is never shown twice. A task pairs with the
 * record it names, then with an unpaired record of the same kind; one record stands for at most one task.
 * A task the server marked saved, recorded or noted counts as shown when `omitRecorded` is set.
 */
export function unrecordedTasks(tasks, records, { omitRecorded = false } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const pool = [...(records ?? [])];
  const take = (matches) => {
    const index = pool.findIndex(matches);
    if (index < 0) return false;
    pool.splice(index, 1);
    return true;
  };
  // Named pairs first, so a task without a name cannot take the record another task names.
  const named = list.map((task) => {
    const id = task.noteRecordId ?? task.recordId;
    return Boolean(id) && take((record) => record.recordId === id);
  });
  return list.filter((task, index) => !named[index]
    && !take((record) => record.kind === TASK_RECORD_KIND[task.kind])
    && !(omitRecorded && (task.saved || task.lookupRecorded || task.noted)));
}
