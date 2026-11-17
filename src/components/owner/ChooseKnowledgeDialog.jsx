import { useRef, useState } from 'react';
import { newKey, ownerApi } from '../../lib/owner-api.js';
import { AppLink } from '../../pages/owner/router.jsx';
import { errorMessage, isConflict } from '../../pages/owner/error-copy.js';
import { Button, Dialog, InlineError, Notice } from './ui.jsx';
import SourceRow from './SourceRow.jsx';
import './choose-knowledge.css';

// MR-S5. The owner picks which business sources one receptionist uses. Saving publishes a new version of that receptionist
// (PUT knowledge-sources-selection) and closes only after the server confirms it. Saving with nothing checked is allowed:
// the message under the list says what happens and Save is never blocked.

const NO_SERVICES_MESSAGE = 'Add at least one service to a chosen source.';

/** The sentence for a failed save. A stale version has its own notice with a Reload button. */
function failureText(failure) {
  if (failure?.code === 'compile_failed' && failure.body?.code === 'no_services') return NO_SERVICES_MESSAGE;
  return errorMessage(failure, { fallback: "Couldn't save. Try again." });
}

/**
 * @param {{agentId: string, name: string, sources: any[], selectedIds: string[], factCounts: Map<string, number>, versionId: string,
 *   onClose: () => void, onSaved: () => void, onReload: () => void}} props
 * `sources` are the business sources that can be chosen; `versionId` is the version the page was loaded on.
 */
export default function ChooseKnowledgeDialog({ agentId, name, sources, selectedIds, factCounts, versionId, onClose, onSaved, onReload }) {
  const [checked, setChecked] = useState(() => new Set(selectedIds.filter((id) => sources.some((source) => source.sourceId === id))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const key = useRef({ payload: '', value: '' });
  const chosen = sources.filter((source) => checked.has(source.sourceId)).map((source) => source.sourceId);
  const changed = chosen.length !== selectedIds.length || chosen.some((id) => !selectedIds.includes(id));

  function toggle(sourceId) {
    setError('');
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId);
      return next;
    });
  }

  async function save() {
    if (!changed) { onClose(); return; }
    // A retry of the same choice reuses its key, so a lost response cannot publish two versions.
    const payload = JSON.stringify([...chosen].sort());
    if (key.current.payload !== payload) key.current = { payload, value: newKey() };
    setBusy(true); setError('');
    try {
      await ownerApi.saveKnowledgeSelection(agentId, { sourceIds: chosen, expectedAgentVersionId: versionId }, key.current.value);
      onSaved();
    } catch (failure) {
      if (isConflict(failure)) setStale(true); else setError(failureText(failure));
      setBusy(false);
    }
  }

  if (sources.length === 0) {
    return <Dialog title="Choose sources" onClose={onClose}>
      <p>No knowledge to choose from yet.</p>
      <div className="owner-actions">
        <AppLink className="bob-button bob-button--primary" to="/app/knowledge" onClick={onClose}>Add knowledge</AppLink>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>;
  }
  return <Dialog title="Choose sources" onClose={onClose} busy={busy}>
    <p className="owner-lede owner-choose__lede">{`${name} uses the sources checked here.`}</p>
    <ul className="owner-source-list owner-choose" aria-label="Sources to use">
      {sources.map((source) => <SourceRow key={source.sourceId} source={source} detailCount={factCounts.get(source.sourceId) ?? 0}
        checkbox={<input type="checkbox" checked={checked.has(source.sourceId)} disabled={busy || stale} onChange={() => toggle(source.sourceId)} />} />)}
    </ul>
    {chosen.length === 0 && !stale && <Notice kind="warning" title={`${name} needs knowledge before it can take calls. Choose at least one source.`} action={null} />}
    {stale && <Notice kind="warning" title={`${name} changed while this page was open. Reload to continue.`} action={<Button variant="secondary" onClick={onReload}>Reload</Button>} />}
    <InlineError>{error}</InlineError>
    <div className="owner-actions">
      <Button onClick={save} busy={busy} disabled={stale}>Save</Button>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
    </div>
  </Dialog>;
}
