import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, CharacterCount, ConfirmDialog, Dialog, InlineError, Progress, StatusChip } from './ui.jsx';
import { errorMessage, isConflict } from '../../pages/owner/error-copy.js';
import { clock, countLabel } from '../../pages/owner/format.js';
import { transcribeDictation } from '../../lib/owner-uploads.js';
import { receptionistName } from '../../lib/receptionist-name.js';

// Pieces of the Knowledge screen (design spec PO-S3): categories, FactRow, FactEditor, the input methods,
// the recorder and ReviewChanges. The page owns the data and the requests; these render and collect input.

/** How often a running extraction is polled, in milliseconds. Tests can shorten it. */
export const pollSettings = { intervalMs: 1500 };

export const ADD_LABEL = {
  business_details: 'Add business detail', services: 'Add service', hours: 'Add hours', locations_service_area: 'Add location or area',
  pricing: 'Add pricing information', policies: 'Add policy', faqs: 'Add FAQ', other: 'Add other information',
};
/** The group a new item in each category is stored under. Hours has three and the owner picks one. */
export const GROUP_OF_CATEGORY = {
  business_details: 'identity_contact', services: 'services', hours: null, locations_service_area: 'locations_service_area',
  pricing: 'pricing_quote_policy', policies: 'booking_cancellation_policy', faqs: 'faq', other: 'other',
};
/** The row shown for a category that has nothing saved yet. "Other" is optional, so it is never listed as missing. */
export const MISSING_LABEL = {
  business_details: 'No business details yet', services: 'No services yet', hours: 'No hours yet', locations_service_area: 'No location or service area yet',
  pricing: 'No pricing yet', policies: 'No policies yet', faqs: 'No FAQs yet',
};
export const HOURS_KINDS = [['office_hours', 'Office hours'], ['service_hours', 'Service hours'], ['appointment_hours', 'Appointment availability']];
const GROUP_NAME = {
  identity_contact: 'Business details', services: 'Services', office_hours: 'Office hours', service_hours: 'Service hours', appointment_hours: 'Appointment availability',
  locations_service_area: 'Locations & service area', pricing_quote_policy: 'Pricing', booking_cancellation_policy: 'Policies', faq: 'FAQs', other: 'Other',
};
export const groupName = (group) => GROUP_NAME[group] ?? 'Other';

const shorten = (text, length = 60) => (text.length > length ? `${text.slice(0, length)}…` : text);
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return 'a web page'; } };

/** "Added by you, typed" and the like (PO-DC6). Website facts say which site they came from. */
export function originText(entry) {
  if (entry.origin === 'website') return `From ${entry.sourceLabel ?? 'the website'}`;
  const how = {
    owner_form: 'typed', owner_text: 'typed', owner_dictation: 'dictated',
    owner_document: entry.sourceFilename ? `from ${entry.sourceFilename}` : 'from a file',
    owner_url: `from ${hostOf(entry.sourceUrl)}`,
  }[entry.origin] ?? 'typed';
  return `Added by you, ${how}`;
}

/** The recovery sentence for a failed extraction. Codes the copy table does not know read as "couldn't read that". */
export function failureMessage(code) {
  return errorMessage({ code }, { fallback: '' }) || errorMessage({ code: 'extraction_unavailable' });
}

/** A server field message without its field prefix ("value: ...") so it reads as a sentence under the field. */
export function fieldMessage(failure) {
  if (isConflict(failure)) return 'Knowledge was updated while you worked. Text still in the box. Try again.';
  const text = errorMessage(failure);
  return text.replace(/^[A-Za-z.]+: /, '').replace(/^./, (letter) => letter.toUpperCase());
}

// ------------------------------------------------------------------ categories and rows

/** @param {any} props */
export function FactRow({ entry, locked, willRemove, onEdit, onDelete, onResolve }) {
  const label = shorten(entry.value);
  return <li className="owner-fact">
    <div className="owner-fact__text">
      <p className="owner-fact__value">{entry.value}</p>
      {entry.scope && <p className="owner-muted">Applies to: {entry.scope}</p>}
      <p className="owner-muted">{entry.sourceErased ? 'Source removed.' : originText(entry)}</p>
      {entry.hasConflict && <p className="owner-fact__flag"><StatusChip kind="attention" /> {"This doesn't match another item. Choose which one to use."}</p>}
      {willRemove && <p className="owner-fact__flag">Will be removed once you apply the change</p>}
    </div>
    <div className="owner-fact__actions">
      {entry.hasConflict && <button type="button" className="owner-text-button" disabled={locked} onClick={() => onResolve(entry)} aria-label={`Choose which item to use: ${label}`}>Choose one</button>}
      <button type="button" className="owner-text-button" disabled={locked} onClick={() => onEdit(entry)} aria-label={`Edit: ${label}`}>Edit</button>
      <button type="button" className="owner-text-button" disabled={locked} onClick={() => onDelete(entry)} aria-label={`Remove: ${label}`}>Remove</button>
    </div>
  </li>;
}

/**
 * PO-DC5. One `<details>` per category that has saved items; the open state is kept by the page (and the address).
 * Adding is done through "Add knowledge", so a category only lists, edits and removes its items.
 * @param {any} props
 */
export function KnowledgeCategory({ group, open, onToggle, locked, removing, onEdit, onDelete, onResolve, name = receptionistName() }) {
  const { category, label, entries, notUsedByBob } = group;
  return <details className="owner-category" open={open} onToggle={(event) => onToggle(category, event.currentTarget.open)}>
    <summary><span className="owner-category__name">{label}</span><span className="owner-category__count">{entries.length === 0 && notUsedByBob.length > 0 ? 'None used' : countLabel(entries.length, 'item')}</span></summary>
    <div className="owner-category__body">
      {entries.length > 0 && <ul className="owner-list">
        {entries.map((entry) => <FactRow key={entry.entryId} entry={entry} locked={locked} willRemove={removing.has(entry.entryId)} onEdit={onEdit} onDelete={onDelete} onResolve={onResolve} />)}
      </ul>}
      {notUsedByBob.length > 0 && <details className="owner-not-used">
        <summary>{`Not used by ${name}`}</summary>
        <ul className="owner-list">
          {notUsedByBob.map((fact) => <li key={fact.entryId}><p className="owner-fact__value">{fact.value}</p><p className="owner-muted">The source looks out of date or unclear.</p></li>)}
        </ul>
      </details>}
    </div>
  </details>;
}

/**
 * Compact rows for what the receptionist has no information on. Each row offers a direct way to add it.
 * @param {{groups: any[], locked: boolean, onAdd: (group: any) => void}} props
 */
export function MissingList({ groups, locked, onAdd }) {
  return <ul className="owner-missing" aria-label="Missing knowledge">
    {groups.map((group) => <li key={group.category}>
      <span>{MISSING_LABEL[group.category]}</span>
      <button type="button" className="owner-text-button" disabled={locked} aria-label={ADD_LABEL[group.category]} onClick={() => onAdd(group)}>Add</button>
    </li>)}
  </ul>;
}

// ------------------------------------------------------------------ the fact editor

/**
 * PO-DC7. Focus starts on the heading, Tab is trapped, Esc cancels, and unsaved text asks before it is discarded.
 * `onSubmit({value, scope, group})` returns a promise; a rejection is shown under the field and the text is kept.
 * @param {{title: string, categoryLabel: string, hours?: boolean, hoursLocked?: boolean, showLocation?: boolean, saveLabel?: string, version?: number|null, initial: {value?: string, scope?: string, group?: string}, onSubmit: (fields: {value: string, scope: string, group: string}) => Promise<any>, onClose: () => void}} props
 */
export function FactEditor({ title, categoryLabel, hours = false, hoursLocked = false, showLocation = true, saveLabel = 'Save for review', initial, onSubmit, onClose }) {
  const [value, setValue] = useState(initial.value ?? '');
  const [scope, setScope] = useState(initial.scope ?? '');
  const [group, setGroup] = useState(initial.group ?? '');
  const [error, setError] = useState('');
  const [groupError, setGroupError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ids = { value: useId(), scope: useId(), error: useId(), groupError: useId(), scopeHint: useId() };
  const valueRef = useRef(null);
  const hoursRef = useRef(null);
  const dirty = value !== (initial.value ?? '') || scope !== (initial.scope ?? '') || (hours && !hoursLocked && group !== (initial.group ?? ''));
  const requestClose = () => { if (busy) return; if (dirty) setConfirming(true); else onClose(); };

  async function submit(event) {
    event.preventDefault();
    if (hours && !group) { setGroupError('Choose what kind of hours these are.'); hoursRef.current?.focus(); return; }
    if (!value.trim()) { setError('Write the details first.'); valueRef.current?.focus(); return; }
    setBusy(true);
    setError('');
    setGroupError('');
    try {
      await onSubmit({ value: value.trim(), scope: scope.trim(), group });
    } catch (failure) {
      setError(fieldMessage(failure));
      setBusy(false);
      valueRef.current?.focus();
    }
  }

  return <>
    <Dialog title={title} onClose={requestClose} busy={busy}>
      <form onSubmit={submit} noValidate>
        <p className="owner-editor__category"><span>Category</span> <strong>{categoryLabel}</strong></p>
        {hours && <fieldset className="owner-fieldset" aria-describedby={groupError ? ids.groupError : undefined}>
          <legend>What kind of hours are these?</legend>
          {HOURS_KINDS.map(([kind, label], index) => <label key={kind} className="owner-radio">
            <input ref={index === 0 ? hoursRef : undefined} type="radio" name="hours-kind" value={kind} checked={group === kind} disabled={hoursLocked} onChange={() => { setGroup(kind); setGroupError(''); }} aria-invalid={groupError ? 'true' : undefined} />
            <span>{label}</span>
          </label>)}
          <InlineError id={ids.groupError}>{groupError}</InlineError>
        </fieldset>}
        <div className="owner-field">
          <label htmlFor={ids.value}>Details</label>
          <textarea id={ids.value} ref={valueRef} value={value} maxLength={1000} onChange={(event) => { setValue(event.target.value); setError(''); }} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? ids.error : undefined} />
          <CharacterCount value={value} max={1000} />
          <InlineError id={ids.error}>{error}</InlineError>
        </div>
        {showLocation && <div className="owner-field">
          <label htmlFor={ids.scope}>Location (optional)</label>
          <input id={ids.scope} type="text" value={scope} maxLength={200} onChange={(event) => setScope(event.target.value)} aria-describedby={ids.scopeHint} />
          <span id={ids.scopeHint} className="owner-count">Leave blank if this applies to the whole business</span>
        </div>}
        <div className="owner-actions">
          <Button type="submit" busy={busy}>{busy ? 'Saving…' : saveLabel}</Button>
          <Button variant="secondary" onClick={requestClose} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Dialog>
    {confirming && <Dialog title="Discard your changes?" onClose={() => setConfirming(false)} defaultFocus="cancel">
      <div className="owner-actions">
        <button type="button" className="bob-button bob-button--secondary" data-dialog-cancel onClick={() => setConfirming(false)}>Keep editing</button>
        <button type="button" className="bob-button bob-button--primary owner-danger" onClick={onClose}>Discard changes</button>
      </div>
    </Dialog>}
  </>;
}

/** Asks which of several items that don't match Bob should use. The others go through review as a removal. */
export function ResolveDialog({ entries, onChoose, onClose, busy, error, name = receptionistName() }) {
  const [kept, setKept] = useState('');
  return <Dialog title={`Which item should ${name} use?`} onClose={onClose} busy={busy}>
    <p>The other item will be removed after you review it.</p>
    <fieldset className="owner-fieldset">
      <legend>{"Items that don't match"}</legend>
      {entries.map((entry) => <label key={entry.entryId} className="owner-radio">
        <input type="radio" name="keep-entry" value={entry.entryId} checked={kept === entry.entryId} onChange={() => setKept(entry.entryId)} />
        <span>{entry.value}<span className="owner-muted"> Source: {entry.sourceLabel ?? 'unknown'}</span></span>
      </label>)}
    </fieldset>
    <InlineError id="owner-resolve-error">{error}</InlineError>
    <div className="owner-actions">
      <Button onClick={() => onChoose(kept)} disabled={!kept} busy={busy}>Use selected item</Button>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
    </div>
  </Dialog>;
}

// ------------------------------------------------------------------ input methods

const INPUT_METHODS = [
  ['text', 'Type', 'Up to 10,000 characters'],
  ['dictation', 'Dictate', 'Up to 2 minutes'],
  ['document', 'Upload a file', 'PDF, Word or text files up to 5 MB'],
  ['url', 'Add a web address', 'One public page'],
];

/** PO-DC8. Only the inputs the API reports as available are offered. Used by the setup screens. */
export function InputMethodBar({ inputs, active, onChoose }) {
  const available = INPUT_METHODS.filter(([key]) => inputs?.[key]);
  const describe = useId();
  if (!available.length) return <p className="owner-muted">{"Longer notes, files and web addresses can't be added right now. Add items one at a time below instead."}</p>;
  return <ul className="owner-input-bar" aria-label="Ways to add information">
    {available.map(([key, label, limit]) => <li key={key}>
      <button type="button" className="owner-method-row" aria-pressed={active === key} aria-label={label} aria-describedby={`${describe}-${key}`} onClick={() => onChoose(key)}>
        <span className="owner-method-row__dot" aria-hidden="true" />
        <span className="owner-method-row__text">
          <span className="owner-method-row__label">{label}</span>
          <span id={`${describe}-${key}`} className="owner-method-row__caption">{limit}</span>
        </span>
      </button>
    </li>)}
  </ul>;
}

/** What each way to add longer material is called in the chooser and in its dialog. */
export const METHOD_LABEL = { text: 'Type a note', dictation: 'Dictate a note', url: 'Add a web page', document: 'Upload a file' };
const METHODS = [
  ['text', METHOD_LABEL.text, 'Up to 10,000 characters'],
  ['dictation', METHOD_LABEL.dictation, 'Up to 2 minutes'],
  ['url', METHOD_LABEL.url, 'One public page'],
  ['document', METHOD_LABEL.document, 'PDF, Word or text files up to 5 MB'],
];
const CATEGORY_CHOICE = {
  business_details: ['Business details', 'Name, phone and email'], services: ['Services', 'What the business offers'], hours: ['Hours', 'When the business is open'],
  locations_service_area: ['Location or service area', 'Where the business works'], pricing: ['Pricing', 'Prices and quotes'], policies: ['Policies', 'Booking and cancellation rules'],
  faqs: ['FAQs', 'Common questions and answers'], other: ['Something else', 'Anything else worth knowing'],
};

/**
 * One choice in the chooser: a title, one short line under it, and the whole row is the button.
 * @param {any} props
 */
function ChoiceRow({ title, caption, onChoose }) {
  return <li><button type="button" className="owner-choice" onClick={onChoose}>
    <span className="owner-choice__title">{title}</span>
    <span className="owner-choice__caption">{caption}</span>
  </button></li>;
}

/**
 * "What do you want to add?" One dialog with every way to add knowledge: a detail by category, or longer material
 * (a note, a web page, a file). Only the inputs the API reports as available are offered (PO-DC8).
 * @param {any} props `{groups, inputs, onCategory(group), onMethod(method), onClose()}`
 */
export function AddChooser({ groups, inputs, onCategory, onMethod, onClose }) {
  const methods = METHODS.filter(([key]) => inputs?.[key]);
  return <Dialog title="What do you want to add?" onClose={onClose}>
    <h3 className="owner-choices__title">Details</h3>
    <ul className="owner-choices" aria-label="Details">
      {groups.map((group) => <ChoiceRow key={group.category} title={CATEGORY_CHOICE[group.category]?.[0] ?? group.label} caption={CATEGORY_CHOICE[group.category]?.[1] ?? ''} onChoose={() => onCategory(group)} />)}
    </ul>
    {methods.length > 0 && <>
      <h3 className="owner-choices__title">Longer material</h3>
      <ul className="owner-choices" aria-label="Longer material">
        {methods.map(([key, label, caption]) => <ChoiceRow key={key} title={label} caption={caption} onChoose={() => onMethod(key)} />)}
      </ul>
    </>}
    <div className="owner-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button></div>
  </Dialog>;
}

/** @param {any} props */
export function TypePanel({ value, onChange, onSubmit, busy, error, submitLabel = 'Review changes', after = null, name = receptionistName() }) {
  const id = useId();
  const hint = useId();
  const errorId = useId();
  return <form className="owner-panel" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <div className="owner-field">
      <label htmlFor={id}>{`What should ${name} know?`}</label>
      <p id={hint} className="owner-muted">{"Up to 10,000 characters. Write it the way you'd tell a new employee."}</p>
      <textarea id={id} value={value} maxLength={10000} onChange={(event) => onChange(event.target.value)} aria-describedby={error ? `${hint} ${errorId}` : hint} aria-invalid={error ? 'true' : undefined} />
      <CharacterCount value={value} max={10000} />
      <InlineError id={errorId}>{error}</InlineError>
    </div>
    <div className="owner-actions"><Button type="submit" busy={busy}>{submitLabel}</Button>{after}</div>
  </form>;
}

/** @param {any} props */
export function UrlPanel({ value, onChange, onSubmit, busy, error, submitLabel = 'Review changes', after = null }) {
  const id = useId();
  const hint = useId();
  const errorId = useId();
  return <form className="owner-panel" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <div className="owner-field">
      <label htmlFor={id}>Web page address</label>
      <p id={hint} className="owner-muted">{'Paste one public page, starting with https://. Only that page is read.'}</p>
      <input id={id} type="url" inputMode="url" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} aria-describedby={error ? `${hint} ${errorId}` : hint} aria-invalid={error ? 'true' : undefined} />
      <InlineError id={errorId}>{error}</InlineError>
    </div>
    <div className="owner-actions"><Button type="submit" busy={busy}>{submitLabel}</Button>{after}</div>
  </form>;
}

export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const DOCUMENT_TYPES = /\.(pdf|docx|txt)$/i;
export const sizeLabel = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** @param {any} props */
export function DocumentPanel({ file, onChoose, onSubmit, busy, error, submitLabel = 'Review changes', after = null }) {
  const id = useId();
  const hint = useId();
  const errorId = useId();
  return <form className="owner-panel" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <div className="owner-field">
      <label htmlFor={id} className="owner-dropzone">Choose a PDF, Word or text file</label>
      <input id={id} type="file" accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onChoose(event.target.files?.[0] ?? null)} aria-describedby={error ? `${hint} ${errorId}` : hint} aria-invalid={error ? 'true' : undefined} />
      <p id={hint} className="owner-muted">{"Up to 5 MB and 50 pages. Scanned pictures of text can't be read yet. Paste the text instead."}</p>
      {file && <p className="owner-fact__value">{file.name} <span className="owner-muted">({sizeLabel(file.size)})</span></p>}
      <InlineError id={errorId}>{error}</InlineError>
    </div>
    <div className="owner-actions"><Button type="submit" busy={busy}>{submitLabel}</Button>{after}</div>
  </form>;
}

/** Client-side check for the file limits, so an oversize or wrong-type file is refused before it is sent. Returns an error code or null. */
export function documentProblem(file) {
  if (!file) return null;
  if (file.size > DOCUMENT_MAX_BYTES) return 'upload_too_large';
  if (!DOCUMENT_TYPES.test(file.name)) return 'unsupported_media_type';
  return null;
}

// ------------------------------------------------------------------ recorder (PO-DC9)

const MAX_RECORDING_SECONDS = 120;

/**
 * Records up to two minutes, turns it into text through the server, and lets the owner edit the text before it is used.
 * Raw audio is never shown or played back and is not kept by this component.
 */
export function Recorder({ agentId, onUse, onTypeInstead, busy }) {
  const [phase, setPhase] = useState('idle');
  const [seconds, setSeconds] = useState(0);
  const [text, setText] = useState('');
  const hold = useRef({ stream: null, recorder: null, timer: null, chunks: [] });
  const textId = useId();

  useEffect(() => () => { clearInterval(hold.current.timer); hold.current.stream?.getTracks().forEach((track) => track.stop()); }, []);

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setPhase('denied'); return; }
    setPhase('requesting');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { setPhase('denied'); return; }
    const recorder = new MediaRecorder(stream);
    hold.current = { stream, recorder, timer: null, chunks: [] };
    recorder.ondataavailable = (event) => { if (event.data?.size) hold.current.chunks.push(event.data); };
    recorder.onstop = async () => {
      clearInterval(hold.current.timer);
      stream.getTracks().forEach((track) => track.stop());
      setPhase('transcribing');
      try {
        const transcript = await transcribeDictation(agentId, new Blob(hold.current.chunks, { type: recorder.mimeType || 'audio/webm' }));
        hold.current.chunks = [];
        setText(transcript);
        setPhase('ready');
      } catch { hold.current.chunks = []; setPhase('failed'); }
    };
    recorder.start();
    setSeconds(0);
    setPhase('recording');
    hold.current.timer = setInterval(() => setSeconds((current) => { if (current + 1 >= MAX_RECORDING_SECONDS) recorder.state === 'recording' && recorder.stop(); return current + 1; }), 1000);
  }
  const stop = () => { if (hold.current.recorder?.state === 'recording') hold.current.recorder.stop(); };

  return <div className="owner-panel owner-recorder">
    {phase === 'idle' && <><p>Record with your microphone</p><Button onClick={start}>Start recording</Button></>}
    {phase === 'requesting' && <p role="status">Waiting for microphone permission</p>}
    {phase === 'denied' && <><p role="status">Microphone access is off. Typing works too.</p><Button variant="secondary" onClick={onTypeInstead}>Type instead</Button></>}
    {phase === 'recording' && <>
      <p><span role="status" className="owner-recording">Recording.</span> <span aria-hidden="true">{clock(seconds)} of 2:00</span></p>
      <Button onClick={stop}>Stop recording</Button>
    </>}
    {phase === 'transcribing' && <p role="status">Turning your recording into text</p>}
    {phase === 'ready' && <>
      <div className="owner-field">
        <label htmlFor={textId}>Check the text below. Edit it before you continue.</label>
        <textarea id={textId} value={text} maxLength={10000} onChange={(event) => setText(event.target.value)} />
        <CharacterCount value={text} max={10000} />
      </div>
      <div className="owner-actions">
        <Button onClick={() => onUse(text)} disabled={!text.trim()} busy={busy}>Use this text</Button>
        <Button variant="secondary" onClick={() => { setText(''); setPhase('idle'); }} disabled={busy}>Discard and record again</Button>
      </div>
    </>}
    {phase === 'failed' && <>
      <p role="alert">{"Couldn't turn that recording into text. The recording wasn't kept."}</p>
      <div className="owner-actions"><Button onClick={() => setPhase('idle')}>Try again</Button><Button variant="secondary" onClick={onTypeInstead}>Type instead</Button></div>
    </>}
  </div>;
}

// ------------------------------------------------------------------ extraction status and review

/**
 * PO-S3 Extracting and Applying: a Processing chip, one status sentence and a Cancel while a job can still be cancelled.
 * @param {any} props
 */
export function ProcessingStatus({ message, onCancel, cancelling }) {
  return <section className="owner-card owner-processing">
    <Progress>{message}</Progress>
    {onCancel && <div className="owner-actions"><Button variant="secondary" onClick={onCancel} busy={cancelling}>Cancel</Button></div>}
  </section>;
}

const ACTION_TAG = { add: 'Add', replace: 'Replace', remove: 'Remove' };
const DECISIONS = [['accept', 'Use this'], ['reject', 'Skip'], ['edited', 'Edit first']];

/** @param {any} props */
function FlagNotes({ candidate, entryValues }) {
  const notes = [];
  if (candidate.flags.includes('conflicts_with_active')) notes.push(`This doesn't match ${entryValues(candidate.conflictEntryIds) || 'an existing item'}.`);
  if (candidate.flags.includes('previously_removed')) notes.push('This was removed earlier.');
  if (candidate.flags.includes('duplicate')) notes.push('This may already be saved.');
  if (candidate.flags.includes('model_uncertain')) notes.push('This may not have been read correctly.');
  return notes.length ? <ul className="owner-flags">{notes.map((note) => <li key={note}>{note}</li>)}</ul> : null;
}

/** @param {any} props */
function CandidateRow({ candidate, inputType, valueOf, currentValue, sourceLabel, choice, onChoose, onEditFirst, receptionist }) {
  const name = `decision-${candidate.candidateId}`;
  const conflictNeeded = candidate.action === 'add' && candidate.flags.includes('conflicts_with_active') && ['accept', 'edited'].includes(choice.decision);
  const existing = candidate.targetEntryId ? currentValue(candidate.targetEntryId) : '';
  const shown = choice.decision === 'edited' ? choice.editedValue : candidate.value;
  return <li className="owner-candidate">
    <p className="owner-candidate__head"><span className="owner-tag">{ACTION_TAG[candidate.action]}</span> <span className="owner-muted">{groupName(candidate.group)}{candidate.scope ? `, ${candidate.scope}` : ''}</span></p>
    {candidate.action === 'replace' && <><p><span className="owner-muted">Now:</span> {existing || 'the current item'}</p><p><span className="owner-muted">New:</span> <strong>{shown}</strong></p></>}
    {candidate.action === 'add' && <p className="owner-fact__value">{shown}</p>}
    {candidate.action === 'remove' && <><p className="owner-fact__value">{candidate.value}</p><p>{`${receptionist} will stop using this.`}</p></>}
    {inputType !== 'form' && candidate.quote && <blockquote className="owner-quote">{candidate.quote}<footer className="owner-muted">From {sourceLabel ?? 'what you added'}</footer></blockquote>}
    <FlagNotes candidate={candidate} entryValues={valueOf} />
    <fieldset className="owner-fieldset owner-decision">
      <legend>Choose what happens to this change.</legend>
      <div className="owner-decision__options">
        {DECISIONS.map(([value, label]) => <label key={value} className="owner-radio">
          <input type="radio" name={name} value={value} checked={choice.decision === value} onChange={() => (value === 'edited' ? onEditFirst(candidate) : onChoose(candidate, { decision: value }))} />
          <span>{label}</span>
        </label>)}
      </div>
      {choice.decision === 'edited' && <button type="button" className="owner-text-button" onClick={() => onEditFirst(candidate)}>Edit the text again</button>}
    </fieldset>
    {conflictNeeded && <fieldset className="owner-fieldset owner-decision">
      <legend>{"What should happen to the item that doesn't match?"}</legend>
      {[['replace_existing', 'Replace it with this'], ['keep_both', 'Keep both']].map(([value, label]) => <label key={value} className="owner-radio">
        <input type="radio" name={`${name}-resolution`} value={value} checked={choice.resolution === value} onChange={() => onChoose(candidate, { resolution: value })} />
        <span>{label}</span>
      </label>)}
    </fieldset>}
  </li>;
}

/**
 * PO-DC10. Header, one row per candidate, and the footer. Apply stays disabled until every row has a decision,
 * every conflict has a resolution, and at least one change would be applied.
 * @param {any} props
 */
export function ReviewChanges({ update, entries, sources, onApply, onCancel, busy, error, name = receptionistName() }) {
  const [choices, setChoices] = useState({});
  const [editing, setEditing] = useState(null);
  const [discarding, setDiscarding] = useState(false);
  const heading = useRef(null);
  const noteId = useId();
  useEffect(() => { heading.current?.focus(); }, []);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.entryId, entry])), [entries]);
  const valueOf = (ids) => (ids ?? []).map((id) => byId.get(id)?.value).filter(Boolean).map((text) => `"${shorten(text, 80)}"`).join(', ');
  const choiceOf = (candidate) => choices[candidate.candidateId] ?? { decision: 'pending' };
  const choose = (candidate, patch) => setChoices((current) => {
    const previous = current[candidate.candidateId] ?? { decision: 'pending' };
    const next = { ...previous, ...patch };
    if (patch.decision && patch.decision !== 'edited') delete next.editedValue;
    return { ...current, [candidate.candidateId]: next };
  });
  const candidates = update.candidates;
  const decided = candidates.every((candidate) => {
    const choice = choiceOf(candidate);
    if (choice.decision === 'pending') return false;
    const needsResolution = candidate.action === 'add' && candidate.flags.includes('conflicts_with_active') && ['accept', 'edited'].includes(choice.decision);
    return !needsResolution || Boolean(choice.resolution);
  });
  const toApply = candidates.filter((candidate) => ['accept', 'edited'].includes(choiceOf(candidate).decision)).length;
  const canApply = candidates.length > 0 && decided && toApply > 0 && !busy;
  const anyDecision = Object.values(choices).some((choice) => choice.decision !== 'pending');
  const reason = !decided ? 'Choose what to do with every change to continue.' : toApply === 0 ? 'Choose at least one change to apply, or cancel.' : '';

  function apply() {
    onApply(candidates.map((candidate) => {
      const choice = choiceOf(candidate);
      return { candidateId: candidate.candidateId, decision: choice.decision, ...(choice.decision === 'edited' ? { editedValue: choice.editedValue } : {}), ...(choice.resolution ? { resolution: choice.resolution } : {}) };
    }), update);
  }

  return <section className="owner-review owner-card" aria-labelledby={`${noteId}-h`}>
    <h2 id={`${noteId}-h`} ref={heading} tabIndex={-1}>{`Review changes for ${name}`}</h2>
    <p>Changes take effect once you apply them.</p>
    {candidates.length === 0
      ? <p className="owner-empty-note">{'Nothing new to add from that.'}</p>
      : <ol className="owner-list">
        {candidates.map((candidate) => <CandidateRow key={candidate.candidateId} candidate={candidate} inputType={update.inputType} valueOf={valueOf} currentValue={(id) => byId.get(id)?.value ?? ''} sourceLabel={sources.get(candidate.sourceId)?.label}
          choice={choiceOf(candidate)} onChoose={choose} onEditFirst={setEditing} receptionist={name} />)}
      </ol>}
    <div className="owner-review__footer">
      {busy && <Progress>Saving your changes…</Progress>}
      <InlineError id={`${noteId}-error`}>{error}</InlineError>
      {candidates.length > 0 && reason && !busy && <p id={noteId} className="owner-muted">{reason}</p>}
      <div className="owner-actions">
        {candidates.length > 0 && <Button onClick={apply} disabled={!canApply} aria-describedby={reason ? noteId : undefined}>{`Apply ${toApply} ${toApply === 1 ? 'change' : 'changes'}`}</Button>}
        <Button variant="secondary" onClick={() => (anyDecision ? setDiscarding(true) : onCancel())} disabled={busy}>{candidates.length ? 'Cancel' : 'Close'}</Button>
      </div>
    </div>
    {editing && <FactEditor title="Edit before using" categoryLabel={groupName(editing.group)} showLocation={false} saveLabel="Use edited text" initial={{ value: choiceOf(editing).editedValue ?? editing.value }}
      onClose={() => setEditing(null)}
      onSubmit={async ({ value }) => { choose(editing, { decision: 'edited', editedValue: value }); setEditing(null); }} />}
    {discarding && <ConfirmDialog title="Discard these changes?" body="Choices made here will be lost." confirmLabel="Discard changes" onCancel={() => setDiscarding(false)} onConfirm={() => { setDiscarding(false); onCancel(); }} />}
  </section>;
}
