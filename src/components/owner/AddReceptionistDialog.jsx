import { useId, useRef, useState } from 'react';
import { newKey, ownerApi } from '../../lib/owner-api.js';
import { NAME_MAX_LENGTH, NAME_TAKEN_MESSAGE, INVALID_NAME_MESSAGE, receptionistNameProblem } from '../../lib/receptionist-name.js';
import { Button, Dialog, InlineError } from './ui.jsx';

// MR-S2, MR-J1. Adds a receptionist to the business. The server starts it from the default setup (the website given
// during onboarding, already selected) and answers with the new receptionist's summary.
// A retry of the same failed submit reuses its Idempotency-Key, so a create whose answer was lost is never made twice.

export const ADD_FAILED_MESSAGE = "Couldn't add the receptionist. Try again.";
export const LIMIT_MESSAGE = 'You can have up to 5 receptionists.';
const DEFAULT_NAME = 'Blake';

/** The name field starts as "Blake" only when no receptionist in the business already has that name (any case). */
export const suggestedName = (takenNames) => (takenNames.some((taken) => taken.trim().toLowerCase() === DEFAULT_NAME.toLowerCase()) ? '' : DEFAULT_NAME);

/** The sentence for a failed add. */
function failureText(error) {
  switch (error?.code) {
    case 'name_taken': return NAME_TAKEN_MESSAGE;
    case 'invalid_name': return INVALID_NAME_MESSAGE;
    case 'receptionist_limit': return LIMIT_MESSAGE;
    case 'sign_in_required': return 'Sign in again to continue.';
    default: return ADD_FAILED_MESSAGE;
  }
}

/** @param {{takenNames: string[], onClose: () => void, onAdded: (summary: any) => void}} props */
export default function AddReceptionistDialog({ takenNames, onClose, onAdded }) {
  const [value, setValue] = useState(() => suggestedName(takenNames));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef({ name: '', key: '' });
  const fieldId = useId();
  const errorId = useId();
  const noteId = useId();

  async function add(event) {
    event.preventDefault();
    if (busy) return;
    const problem = receptionistNameProblem(value);
    if (problem) { setError(problem); return; }
    const name = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
    // The same name after a failure is the same submit; a changed name is a new one.
    if (attempt.current.name !== name) attempt.current = { name, key: newKey() };
    setBusy(true); setError('');
    try {
      const summary = await ownerApi.createReceptionist({ name }, attempt.current.key);
      onAdded(summary);
    } catch (failure) {
      // The server refuses a key that arrives with different content, so a conflict starts over with a new key.
      if (failure?.code === 'idempotency_conflict') attempt.current = { name: '', key: '' };
      setError(failureText(failure));
      setBusy(false);
    }
  }

  return <Dialog title="Add receptionist" onClose={onClose} busy={busy} defaultFocus="field">
    <form noValidate onSubmit={add}>
      <p id={noteId}>It starts with the website you gave during setup. Change what it knows any time in Knowledge.</p>
      <div className="owner-field">
        <label htmlFor={fieldId}>Name</label>
        <input id={fieldId} type="text" autoComplete="off" maxLength={NAME_MAX_LENGTH + 20} value={value} disabled={busy}
          onFocus={(event) => event.target.select()} onChange={(event) => { setValue(event.target.value); setError(''); }}
          aria-describedby={error ? `${noteId} ${errorId}` : noteId} aria-invalid={error ? 'true' : undefined} />
        <InlineError id={errorId}>{error}</InlineError>
      </div>
      <div className="owner-actions">
        <Button type="submit" busy={busy} disabled={!value.trim()}>Add</Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </form>
  </Dialog>;
}
