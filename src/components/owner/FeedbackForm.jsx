import { useId, useRef, useState } from 'react';
import { newKey, ownerApi } from '../../lib/owner-api.js';
import { errorMessage } from '../../pages/owner/error-copy.js';
import { isSignedOut } from './access.js';
import { useDraft } from './hooks.js';
import { Button, CharacterCount, InlineError, Notice } from './ui.jsx';
import './feedback.css';

// PO-DC11. One form for the first-visit cards and the feedback screen. The draft is kept in sessionStorage,
// nothing is shown as sent until the server confirms, and a retry of the same content reuses its idempotency key.

export const FEEDBACK_TEXT_MAX = 10_000;
export const FEEDBACK_CATEGORIES = [
  ['quality', 'How the receptionist sounded or handled the call'],
  ['functionality', "Something the receptionist couldn't do"],
  ['other', 'Something else'],
];

const KEPT = 'Message still in the box.';

/** The sentence under the field after a failed send. The generic case is the exact design copy. */
function sendFailure(error) {
  switch (error?.code) {
    case 'connection_failed': return `${errorMessage(error)} ${KEPT}`;
    case 'rate_limited': return `${errorMessage(error)} ${KEPT}`;
    case 'input_too_large': return errorMessage(error);
    case 'conversation_not_found': return `That conversation is no longer available. Choose another, or send without one. ${KEPT}`;
    default: return `Couldn't send that. ${KEPT} Try sending again.`;
  }
}

/**
 * @param {object} props
 * @param {string} props.agentId
 * @param {string} props.draftKey sessionStorage key for the unsent text
 * @param {string} props.textLabel visible label of the text field
 * @param {string} [props.sendLabel]
 * @param {string|null} [props.fixedCategory] a category the screen decides (no radios are shown)
 * @param {string} [props.initialCategory]
 * @param {Array<{conversationId: string, label: string}>|null} [props.conversations] shows the "Which conversation?" select
 * @param {string} [props.initialConversationId]
 * @param {(sent: {receipt: any, key: string, text: string}) => Promise<void>} [props.afterSend] runs after the server saved the feedback; a throw keeps the key so a retry replays the same receipt
 * @param {(error: any) => string} [props.afterFailure] the sentence when `afterSend` fails
 * @param {(sent: {receipt: any, text: string}) => void} [props.onSent]
 * @param {() => void} [props.signIn]
 */
export default function FeedbackForm({ agentId, draftKey, textLabel, sendLabel = 'Send to the Frontline team', fixedCategory = null, initialCategory = '', conversations = null, initialConversationId = '', afterSend, afterFailure, onSent, signIn }) {
  const ids = useId();
  const draft = useDraft(draftKey);
  const [picked, setPicked] = useState(initialCategory);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [phase, setPhase] = useState('idle');
  const [failure, setFailure] = useState(/** @type {null|{kind: 'signin'}|{kind: 'send'|'after', message: string}} */ (null));
  const [missingCategory, setMissingCategory] = useState(false);
  const attempt = useRef(/** @type {{digest: string|null, key: string|null}} */ ({ digest: null, key: null }));
  const sending = useRef(false);
  const firstRadio = useRef(null);
  const textField = useRef(null);
  const text = draft.value;
  const overLimit = text.length > FEEDBACK_TEXT_MAX;
  const ready = text.trim().length > 0 && !overLimit;

  async function submit(event) {
    event?.preventDefault();
    if (sending.current) return;
    const category = fixedCategory ?? picked;
    if (!category) { setMissingCategory(true); firstRadio.current?.focus(); return; }
    if (!ready) { textField.current?.focus(); return; }
    setMissingCategory(false); setFailure(null);
    const trimmed = text.trim();
    const payload = { category, inputMethod: 'text', text: trimmed, ...(conversationId ? { conversationId } : {}) };
    const digest = JSON.stringify(payload);
    // The same content keeps its key across retries, so a lost response returns the same receipt. Edited content is a new submission.
    if (attempt.current.digest !== digest) attempt.current = { digest, key: newKey() };
    const key = /** @type {string} */ (attempt.current.key);
    sending.current = true; setPhase('sending');
    let receipt;
    try {
      receipt = await ownerApi.submitFeedback(agentId, payload, key);
    } catch (error) {
      sending.current = false; setPhase('idle');
      setFailure((await isSignedOut(error)) ? { kind: 'signin' } : { kind: 'send', message: sendFailure(error) });
      return;
    }
    try {
      await afterSend?.({ receipt, key, text: trimmed });
    } catch (error) {
      sending.current = false; setPhase('idle');
      setFailure((await isSignedOut(error)) ? { kind: 'signin' } : { kind: 'after', message: afterFailure?.(error) ?? `Message saved, but the next step didn't finish. ${KEPT} Try again.` });
      return;
    }
    attempt.current = { digest: null, key: null };
    sending.current = false; setPhase('idle');
    draft.setValue('');
    onSent?.({ receipt, text: trimmed });
  }

  const textId = `${ids}-text`;
  const errorId = `${ids}-error`;
  const categoryErrorId = `${ids}-category-error`;
  const sendingNow = phase === 'sending';
  return <form className="owner-feedback-form" onSubmit={submit} noValidate>
    {!fixedCategory && <fieldset className="owner-fieldset">
      <legend>What is this about?</legend>
      {FEEDBACK_CATEGORIES.map(([value, label], index) => <label className="owner-radio" key={value}>
        <input ref={index === 0 ? firstRadio : null} type="radio" name={`${ids}-category`} value={value} checked={picked === value}
          aria-invalid={missingCategory || undefined} aria-describedby={missingCategory ? categoryErrorId : undefined}
          onChange={() => { setPicked(value); setMissingCategory(false); }} />
        <span>{label}</span>
      </label>)}
      {missingCategory && <InlineError id={categoryErrorId}>Choose what this is about.</InlineError>}
    </fieldset>}
    {conversations && <div className="owner-field">
      <label className="owner-field__label" htmlFor={`${ids}-conversation`}>Which conversation?</label>
      <select id={`${ids}-conversation`} value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
        <option value="">Not about one conversation</option>
        {conversations.map((item) => <option key={item.conversationId} value={item.conversationId}>{item.label}</option>)}
      </select>
    </div>}
    <div className="owner-field">
      <label className="owner-field__label" htmlFor={textId}>{textLabel}</label>
      <textarea id={textId} ref={textField} value={text} onChange={(event) => draft.setValue(event.target.value)}
        aria-invalid={overLimit || undefined} aria-describedby={overLimit ? errorId : undefined} />
      <CharacterCount value={text} max={FEEDBACK_TEXT_MAX} />
      {overLimit && <InlineError id={errorId}>That&apos;s too big. Use up to 10,000 characters.</InlineError>}
      {draft.restored && text && <p className="owner-form-note" role="status">Unsent draft restored.</p>}
    </div>
    {failure?.kind === 'signin' && <Notice kind="warning" action={signIn && <Button onClick={signIn}>Sign in</Button>}>Sign in again to send this. Message still in the box.</Notice>}
    {(failure?.kind === 'send' || failure?.kind === 'after') && <>
      <InlineError>{failure.message}</InlineError>
      <div className="owner-actions"><Button variant="secondary" onClick={submit} disabled={sendingNow}>Try again</Button></div>
    </>}
    {sendingNow && <p className="owner-form-status" role="status">Sending your message</p>}
    <div className="owner-actions">
      <button type="submit" className="bob-button bob-button--primary" disabled={!ready || sendingNow}>{sendingNow ? 'Sending…' : sendLabel}</button>
    </div>
  </form>;
}
