import { useCallback, useEffect, useState } from 'react';
import { frontlineApi } from '../../lib/frontline-api.js';
import CallSummary from './CallSummary.jsx';

const REQUEST_FIELDS = [
  ['callerName', 'Name'], ['contactPhone', 'Phone'], ['contactEmail', 'Email'],
  ['serviceNeed', 'Service'], ['propertyCity', 'Property city'], ['propertyType', 'Property type'],
  ['company', 'Company'], ['preferredDay', 'Preferred day'], ['preferredWindow', 'Preferred time'],
  ['timezone', 'Time zone'], ['recurrence', 'How often'], ['notes', 'Notes'],
];

function HistoryCard({ label, title, savedAt, children, key: _key = undefined }) {
  void _key;
  return <article className="history-card"><div><p className="history-card__label">{label}</p><h3>{title}</h3>{savedAt && <time dateTime={savedAt}>{new Date(savedAt).toLocaleString()}</time>}</div>{children}</article>;
}

export default function OwnerHistory({ resource }) {
  const [state, setState] = useState('loading');
  const [history, setHistory] = useState(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async (signal) => {
    if (!resource?.id || !['agent', 'workspace'].includes(resource.kind)) return;
    setState('loading'); setMessage('');
    try {
      const response = await frontlineApi.getOwnerHistory(resource.kind, resource.id, signal);
      if (response?.resourceKind !== resource.kind || response?.resourceId !== resource.id) throw new Error("Couldn't load this history.");
      setHistory(response); setState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setMessage([401, 403, 404].includes(error?.status)
        ? 'Sign in with the account that saved this receptionist to see its history.'
        : error?.message || "Couldn't load history.");
      setState('error');
    }
  }, [resource?.id, resource?.kind]);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  if (state === 'loading') return <section className="owner-history" aria-labelledby="history-title"><h2 id="history-title">History</h2><p role="status">Loading history…</p></section>;
  if (state === 'error') return <section className="owner-history" aria-labelledby="history-title"><h2 id="history-title">History</h2><p role="alert">{message}</p><button className="bob-button bob-button--secondary" type="button" onClick={() => load()}>Try again</button></section>;

  const requests = Array.isArray(history?.requests) ? history.requests : [];
  const cases = Array.isArray(history?.cases) ? history.cases : [];
  const lookups = Array.isArray(history?.lookups) ? history.lookups : [];
  const callSummaries = Array.isArray(history?.callSummaries) ? history.callSummaries : [];
  if (!requests.length && !cases.length && !lookups.length && !callSummaries.length) return <section className="owner-history" aria-labelledby="history-title"><h2 id="history-title">History</h2><p>No requests, complaints, or call results yet.</p></section>;
  return <section className="owner-history" aria-labelledby="history-title"><div className="owner-history__head"><div><p className="setup-card__label">Private to this account</p><h2 id="history-title">History</h2></div><button className="bob-button bob-button--quiet" type="button" onClick={() => load()}>Refresh</button></div><div className="history-list">
    {requests.map((request) => <HistoryCard key={request.recordId} label="Request saved" title={request.fields?.serviceNeed || 'Service request'} savedAt={request.savedAt}><dl>{REQUEST_FIELDS.filter(([key]) => request.fields?.[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{request.fields[key]}</dd></div>)}</dl><p className="history-card__truth">Request only. Nothing booked or sent.</p></HistoryCard>)}
    {cases.map((item) => <HistoryCard key={item.recordId} label={item.kind === 'escalation' ? 'Human help request saved' : 'Complaint saved'} title={item.context?.summary || (item.kind === 'escalation' ? 'Human help requested' : 'Feedback for review')} savedAt={item.savedAt}><dl>{[['callerName', 'Name'], ['contactPhone', 'Phone'], ['contactEmail', 'Email']].filter(([key]) => item.context?.[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{item.context[key]}</dd></div>)}</dl>{item.escalationReason && <p>Reason: {item.escalationReason.replaceAll('_', ' ')}.</p>}<p className="history-card__truth">Saved for review. Nothing was sent to anyone.</p></HistoryCard>)}
    {lookups.map((lookup) => <HistoryCard key={lookup.result?.lookupId || `${lookup.workflowInstanceId}-${lookup.recordedAt}`} label={`${lookup.action === 'cancel' ? 'Cancellation' : 'Reschedule'} check`} title={lookup.result?.kind === 'not_found' ? 'No matching appointment' : lookup.result?.kind === 'verification_required' ? 'More details needed' : "Couldn't check appointments"} savedAt={lookup.recordedAt}><p className="history-card__truth">{lookup.result?.kind === 'not_found' ? 'No appointment was changed.' : "Couldn't check. No appointment was changed."}</p></HistoryCard>)}
    {callSummaries.map((summary) => <div className="history-card" key={summary.demoId}><p className="history-card__label">Call result</p>{summary.endedAt && <time dateTime={summary.endedAt}>{new Date(summary.endedAt).toLocaleString()}</time>}<CallSummary summary={summary} omitRecordedTasks /></div>)}
  </div></section>;
}
