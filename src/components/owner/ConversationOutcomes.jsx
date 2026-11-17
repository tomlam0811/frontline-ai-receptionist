import './conversations.css';
import { useRef, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import ReviewNote, { recordNotes } from '../product/ReviewNote.jsx';
import { Button, InlineError } from './ui.jsx';

// PO-DC16 (outcomes), VA-D13. The Needs review notes saved during one conversation. The owner marks a note done
// once it is handled, and can undo that. The status is saved on the note, so it is the same after a reload.

/** @param {{agentId?: string, conversationId?: string, record: any, key?: any}} props */
function OutcomeNote({ agentId, conversationId, record }) {
  const [status, setStatus] = useState(record.reviewStatus === 'done' ? 'done' : 'needs_review');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const button = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const canReview = Boolean(agentId && conversationId && record.recordId);

  async function review() {
    const next = status === 'done' ? 'needs_review' : 'done';
    setBusy(true); setFailed(false);
    try {
      const updated = await ownerApi.reviewOutcome(agentId, conversationId, record.recordId, next);
      setStatus(updated?.reviewStatus === 'done' || updated?.reviewStatus === 'needs_review' ? updated.reviewStatus : next);
    } catch {
      // The note keeps the status it had; the same button tries again.
      setFailed(true);
    } finally {
      setBusy(false);
      // The button was disabled while saving, which drops focus. Put it back for keyboard users.
      requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) button.current?.focus(); });
    }
  }

  return <ReviewNote item={record} status={status}>
    {canReview && <div className="owner-actions">
      <Button ref={button} variant="secondary" size="small" busy={busy} onClick={review}>{busy ? 'Saving…' : status === 'done' ? 'Undo' : 'Mark as done'}</Button>
    </div>}
    <InlineError>{failed ? "Couldn't update this. Try again." : ''}</InlineError>
  </ReviewNote>;
}

/** @param {{outcomes: {requests?: any[], cases?: any[]}|null, agentId?: string, conversationId?: string}} props */
export default function ConversationOutcomes({ outcomes, agentId, conversationId }) {
  const notes = recordNotes(outcomes);
  if (!notes.length) return null;
  return <section className="owner-outcomes" aria-label="Outcomes">
    <h2>Outcomes</h2>
    <div className="history-list">
      {notes.map((record, index) => <OutcomeNote key={record.recordId ?? `${record.kind}-${index}`} agentId={agentId} conversationId={conversationId} record={record} />)}
    </div>
  </section>;
}
