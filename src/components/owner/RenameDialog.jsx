import { useId, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { NAME_MAX_LENGTH, NAME_TAKEN_MESSAGE, INVALID_NAME_MESSAGE, receptionistName, receptionistNameProblem } from '../../lib/receptionist-name.js';
import { errorMessage } from '../../pages/owner/error-copy.js';
import { Button, Dialog, InlineError } from './ui.jsx';

// MR-J3. Renames a receptionist. The name lives on the receptionist, not on a version, so saving publishes nothing.
// The new name is shown only after the server confirms it, so every screen reads the same value.

/** The sentence for a failed save. */
function failureText(error) {
  if (error?.code === 'name_taken') return NAME_TAKEN_MESSAGE;
  if (error?.code === 'invalid_name') return INVALID_NAME_MESSAGE;
  return errorMessage(error);
}

/** @param {{agentId: string, summary: any, onClose: () => void, onSaved: (name: string) => void}} props */
export default function RenameDialog({ agentId, summary, onClose, onSaved }) {
  const current = receptionistName(summary);
  const [value, setValue] = useState(current);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  async function save(event) {
    event.preventDefault();
    const problem = receptionistNameProblem(value);
    if (problem) { setError(problem); return; }
    const name = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
    if (name === current) { onClose(); return; }
    setBusy(true); setError('');
    try {
      const saved = await ownerApi.renameReceptionist(agentId, name);
      onSaved(saved.name);
    } catch (failure) {
      setError(failureText(failure));
      setBusy(false);
    }
  }

  return <Dialog title="Rename" onClose={onClose} busy={busy} defaultFocus="field">
    <form noValidate onSubmit={save}>
      <div className="owner-field">
        <label htmlFor={fieldId}>Name</label>
        <input id={fieldId} type="text" autoComplete="off" maxLength={NAME_MAX_LENGTH + 20} value={value} disabled={busy}
          onFocus={(event) => event.target.select()} onChange={(event) => { setValue(event.target.value); setError(''); }}
          aria-describedby={error ? errorId : undefined} aria-invalid={error ? 'true' : undefined} />
        <InlineError id={errorId}>{error}</InlineError>
      </div>
      <div className="owner-actions">
        <Button type="submit" busy={busy}>Save</Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </form>
  </Dialog>;
}
