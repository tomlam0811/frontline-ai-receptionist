import { receptionistName } from '../../lib/receptionist-name.js';
import './meet-bob.css';
import CallSummary from './CallSummary.jsx';

const FIELD_LABELS = {
  callerName: 'Name', contactPhone: 'Phone', contactEmail: 'Email', serviceNeed: 'Service', propertyCity: 'Property city',
  propertyType: 'Property type', company: 'Company', preferredDay: 'Preferred day', preferredWindow: 'Preferred time', timezone: 'Time zone', recurrence: 'How often', notes: 'Notes',
};

function receiptFor(result, record) {
  return (Array.isArray(result?.receipts) ? result.receipts : []).find((receipt) => receipt.receiptId === record?.receiptId);
}

function SavedRequest({ request, receipt, key: _key = undefined }) {
  void _key;
  const saved = receipt?.outcome === 'saved' && receipt.operationKind === 'request' && receipt.recordId === request.recordId;
  return <article className={`outcome-card ${saved ? '' : 'outcome-card--error'}`}><p className="outcome-card__label">{saved ? 'Request saved' : 'Save not confirmed'}</p><h2>{request.fields?.serviceNeed || 'Service request'}</h2><dl className="bob-result__fields">{Object.entries(FIELD_LABELS).filter(([key]) => request.fields?.[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{request.fields[key]}</dd></div>)}</dl><p className="bob-result__limit">{saved ? 'Saved for review. Nothing was booked or sent.' : "Couldn't confirm that this request was saved."}</p></article>;
}

function SavedCase({ item, receipt, key: _key = undefined }) {
  void _key;
  const saved = receipt?.outcome === 'saved' && receipt.operationKind === (item.kind === 'complaint' ? 'case' : 'escalation') && receipt.recordId === item.recordId;
  return <article className={`outcome-card ${saved ? '' : 'outcome-card--error'}`}><p className="outcome-card__label">{saved ? `${item.kind === 'complaint' ? 'Complaint' : 'Human help request'} saved` : 'Save not confirmed'}</p><h2>{item.context?.summary || (item.kind === 'complaint' ? 'Feedback for review' : 'Human help requested')}</h2>{item.escalationReason && <p>Reason: {item.escalationReason.replaceAll('_', ' ')}.</p>}<p className="bob-result__limit">{saved ? 'Saved for review. No one was called or notified.' : "Couldn't confirm that these details were saved."}</p></article>;
}

// Voice v2 records carry a review status and are Needs review notes (VA-D4). Older records keep their saved cards.
const isNote = (record) => typeof record?.reviewStatus === 'string';

export default function DemoResult({ result, onBack = undefined, onStartAgain = undefined, onSave = undefined, name = receptionistName() }) {
  const allRequests = Array.isArray(result?.requests) ? result.requests : [];
  const allCases = Array.isArray(result?.cases) ? result.cases : [];
  const notes = { requests: allRequests.filter(isNote), cases: allCases.filter(isNote) };
  const requests = allRequests.filter((record) => !isNote(record));
  const cases = allCases.filter((record) => !isNote(record));
  const lookups = Array.isArray(result?.lookups) ? result.lookups : [];
  const failed = (Array.isArray(result?.receipts) ? result.receipts : []).filter((receipt) => receipt.outcome === 'failed');
  const tasks = Array.isArray(result?.callSummary?.tasks) ? result.callSummary.tasks : [];
  const hasUnrecordedTask = tasks.some((task) => !task.saved && !task.lookupRecorded);
  const noOutcome = !allRequests.length && !allCases.length && !lookups.length && !failed.length && !hasUnrecordedTask;
  const terminalCopy = {
    caller_ended: 'Call ended at your request.',
    human_preference: 'A person was requested, so the call ended.',
    urgency: 'Urgent help was requested, so the call ended.',
    safety_emergency: 'An immediate safety concern came up, so the call ended.',
    blocking_unknown: `${name} couldn't confirm something needed to continue.`,
    setup_timeout: "The call didn't start in time.",
    soft_close_elapsed: 'The call reached its time limit.',
    hard_end_elapsed: 'The call reached its time limit.',
    provider_failure: 'Sorry, the call had a problem and ended early.',
  };
  return <main className="bob-page bob-result" aria-labelledby="bob-result-title"><section className="bob-intro"><p className="bob-eyebrow">{`Call with ${name}`}</p><h1 id="bob-result-title">Call result</h1></section>
    <CallSummary summary={result?.callSummary} records={notes} listedSeparately={{ requests, cases }} showHeading={false} omitRecordedTasks showEmptyState={false} />
    <section className="outcome-list" aria-label="Saved from this call">
      {requests.map((request) => <SavedRequest key={request.recordId} request={request} receipt={receiptFor(result, request)} />)}
      {cases.map((item) => <SavedCase key={item.recordId} item={item} receipt={receiptFor(result, item)} />)}
      {lookups.map((lookup) => <article className="outcome-card" key={lookup.result?.lookupId || lookup.recordedAt}><p className="outcome-card__label">{lookup.action === 'cancel' ? 'Cancellation check' : 'Reschedule check'}</p><h2>{lookup.result?.kind === 'not_found' ? 'No matching appointment' : lookup.result?.kind === 'verification_required' ? 'More details needed' : "Couldn't check appointments"}</h2><p className="bob-result__limit">{lookup.result?.kind === 'not_found' ? 'No matching appointment was found. No appointment was changed.' : "Couldn't finish this check. No appointment was changed."}</p></article>)}
      {failed.map((receipt) => <article className="outcome-card outcome-card--error" key={receipt.receiptId} role="alert"><p className="outcome-card__label">Save failed</p><h2>{receipt.operationKind === 'case' ? 'Complaint not saved' : receipt.operationKind === 'escalation' ? 'Human help request not saved' : 'Request not saved'}</h2><p>{"These details weren't saved. Try the call again."}</p></article>)}
      {noOutcome && <article className="outcome-card bob-result__empty"><h2>No request came up on this call.</h2></article>}
    </section>
    {result?.terminalReason && <p className="terminal-note">{terminalCopy[result.terminalReason] || 'The call ended.'}</p>}
    <div className="bob-actions">{onSave && <button type="button" className="bob-button bob-button--primary" onClick={onSave}>{result?.mode === 'frontline_qa' ? 'Save conversation' : 'Save receptionist'}</button>}{onBack && <button type="button" className="bob-button bob-button--secondary" onClick={onBack}>{`Meet ${name}`}</button>}{onStartAgain && <button type="button" className="bob-button bob-button--quiet" onClick={onStartAgain}>Start over</button>}</div>
  </main>;
}
