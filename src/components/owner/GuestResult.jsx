import { useRef, useState } from 'react';
import { newKey, guestApi } from '../../lib/owner-api.js';
import { Button, CharacterCount, InlineError } from './ui.jsx';
import { FocusHeading } from './FocusHeading.jsx';
import CallSummary from '../product/CallSummary.jsx';
import { errorMessage } from '../../pages/owner/error-copy.js';
import { formatDateTime } from '../../pages/owner/format.js';

// PO-S7 result: what the guest sees after their one conversation. Their own summary only, and an optional
// note for the builder while the 24 hour feedback window is open. Nothing here reads owner content.

const MAX_FEEDBACK = 10_000;

function FeedbackCard({ onDone }) {
  const [text, setText] = useState('');
  const [state, setState] = useState({ name: 'idle' });
  const key = useRef(newKey());
  async function send() {
    setState({ name: 'sending' });
    try {
      const receipt = await guestApi.feedback({ category: 'quality', inputMethod: 'text', text: text.trim() }, key.current);
      setState({ name: 'sent', receipt });
    } catch (error) {
      if (error?.code === 'feedback_window_closed') { onDone('closed'); return; }
      setState({ name: 'failed', error });
    }
  }
  if (state.name === 'sent') return <section className="owner-card owner-card--quiet" aria-labelledby="owner-guest-feedback-title">
    <h2 id="owner-guest-feedback-title"><span aria-hidden="true">✓ </span>Sent to the team</h2>
    <p>Thanks. The Frontline team will read it.</p>
    <p className="owner-muted">Reference {String(state.receipt.feedbackId ?? '').slice(0, 8)}. {formatDateTime(state.receipt.receivedAt)}</p>
  </section>;
  const empty = !text.trim();
  return <section className="owner-card" aria-labelledby="owner-guest-feedback-title">
    <h2 id="owner-guest-feedback-title">How was this conversation?</h2>
    <label className="owner-field">
      <span>Feedback</span>
      <textarea value={text} maxLength={MAX_FEEDBACK} onChange={(event) => setText(event.target.value)} aria-describedby="owner-guest-feedback-hint" aria-invalid={state.name === 'failed' ? 'true' : undefined} />
    </label>
    <CharacterCount value={text} max={MAX_FEEDBACK} />
    <p className="owner-muted" id="owner-guest-feedback-hint">The Frontline team may read this.</p>
    {state.name === 'failed' && <InlineError>{state.error?.code === 'connection_failed' ? errorMessage(state.error) : "Feedback not sent. It's still in the box. Try again."}</InlineError>}
    <div className="owner-actions">
      <Button busy={state.name === 'sending'} disabled={empty} onClick={send}>{state.name === 'sending' ? 'Sending…' : state.name === 'failed' ? 'Try again' : 'Send feedback'}</Button>
      <Button variant="secondary" disabled={state.name === 'sending'} onClick={() => onDone('skipped')}>No thanks</Button>
    </div>
  </section>;
}

/** @param {{result: any, name: string, businessName: string|null}} props `result` is GET /v1/shared/result. */
export default function GuestResult({ result, name, businessName }) {
  const [feedback, setFeedback] = useState(result.feedbackOpen ? 'open' : 'closed');
  return <>
    <FocusHeading as="h1">{`Thanks for talking with ${name}.`}</FocusHeading>
    <CallSummary summary={result.callSummary} audience="caller" businessName={businessName} />
    {feedback === 'open' && <FeedbackCard onDone={setFeedback} />}
    {feedback === 'closed' && <p className="owner-muted">Feedback is closed for this conversation.</p>}
    {feedback === 'skipped' && <p className="owner-muted">You can close this page.</p>}
  </>;
}
