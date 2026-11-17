import { useId, useMemo, useState } from 'react';
import { ownerApi, newKey } from '../../lib/owner-api.js';
import { AppLink } from './router.jsx';
import { Button, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { AccessGate, AppliedBanner, BackToBob, ConflictNotice, useBobSummary } from '../../components/owner/BobFrame.jsx';
import { errorMessage, isConflict } from './error-copy.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import './bob.css';

// PO-S9 Capabilities. Four workflows can be switched on or off and are saved as a new version. Answering questions from
// Knowledge and passing urgent calls on are always on, so they are not listed. The add-ons under Coming soon are not built yet.

const SWITCHES = [
  { id: 'WF-02', name: 'Suggest services', sentence: 'Helps callers choose a service.' },
  { id: 'WF-03', name: 'Take service requests', sentence: 'Collects what the caller needs for you to review.' },
  { id: 'WF-04', name: 'Look up appointments', sentence: 'Finds an existing appointment request.' },
  { id: 'WF-05', name: 'Save complaints', sentence: 'Saves a complaint for you to review.' },
];

const COMING_SOON = ['Email me each request', 'Hand off to a person', 'Reschedule or cancel appointments'];

/** @param {any} props */
function SwitchRow({ row, enabled, saving, onToggle }) {
  const nameId = useId();
  const noteId = useId();
  return <li className="owner-cap-row">
    <div className="owner-cap-row__text">
      <strong id={nameId}>{row.name}</strong>
      <p id={noteId}>{row.sentence}</p>
    </div>
    <label className="owner-switch">
      <input type="checkbox" role="switch" checked={enabled} disabled={saving} aria-labelledby={nameId} aria-describedby={noteId} onChange={(event) => onToggle(row.id, event.target.checked)} />
      <span className="owner-switch__track" aria-hidden="true"><span className="owner-switch__thumb" /></span>
      <span className="owner-switch__text">{enabled ? 'On' : 'Off'}</span>
    </label>
  </li>;
}

/** @param {any} props */
export default function Capabilities({ agentId, signIn }) {
  const bob = useBobSummary(agentId);
  const ok = bob.access === 'ok';
  const name = receptionistName(bob.summary);
  const capabilities = useLoad((signal) => (ok ? ownerApi.getCapabilities(agentId, signal) : Promise.resolve(null)), [agentId, ok]);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [applied, setApplied] = useState(false);
  const [attempt, setAttempt] = useState({ payload: '', key: '' });
  usePageTitle('Capabilities', bob.status !== 'loading' && (!ok || capabilities.status !== 'loading'));

  const server = useMemo(() => Object.fromEntries((capabilities.data?.workflows ?? []).map((item) => [item.workflowId, item.enabled])), [capabilities.data]);
  const enabledOf = (id) => (id in edits ? edits[id] : server[id] ?? true);
  const changed = Object.keys(edits).length > 0;

  function toggle(id, value) {
    setApplied(false);
    setError(null);
    setEdits((current) => {
      const next = { ...current };
      if (server[id] === value) delete next[id]; else next[id] = value;
      return next;
    });
  }

  async function save() {
    const payload = JSON.stringify(edits);
    const key = attempt.payload === payload ? attempt.key : newKey();
    setAttempt({ payload, key });
    setSaving(true);
    setError(null);
    try {
      await ownerApi.saveCapabilities(agentId, { baseAgentVersionId: capabilities.data.currentAgentVersionId, expectedPointerGeneration: capabilities.data.pointerGeneration, workflows: edits }, key);
      setApplied(true);
      setEdits({});
      setAttempt({ payload: '', key: '' });
      capabilities.reload();
      bob.reload();
    } catch (failure) {
      if (isConflict(failure)) { setConflict(true); capabilities.reload(); bob.reload(); } else setError(failure);
    } finally { setSaving(false); }
  }

  function discard() { setEdits({}); setConflict(false); setError(null); capabilities.reload(); }

  const blocked = bob.status === 'error' || (bob.status === 'ready' && !ok);
  return <Shell wide>
    {bob.status === 'loading' && <><h1>Capabilities</h1><Loading>Loading your receptionist…</Loading></>}
    {blocked && <AccessGate bob={bob} signIn={signIn} />}
    {ok && <>
      <BackToBob agentId={agentId} name={name} />
      <h1>Capabilities</h1>
      <p className="owner-lede">{`Choose what ${name} can do.`}</p>
      {capabilities.status === 'loading' && <Loading>Loading capabilities…</Loading>}
      {capabilities.status === 'error' && <Notice kind="error" title="We couldn't load capabilities." action={<Button variant="secondary" onClick={capabilities.reload}>Try again</Button>}>{errorMessage(capabilities.error)}</Notice>}
      {applied && <AppliedBanner agentId={agentId} name={name} />}
      {conflict && <ConflictNotice name={name} onReview={() => { setConflict(false); capabilities.reload(); }} onDiscard={discard} />}
      {capabilities.data && <>
        {error && <Notice kind="error" title="We couldn't save that change." action={<Button variant="secondary" onClick={save}>Try again</Button>}>{errorMessage(error)}</Notice>}
        <ul className="owner-list owner-cap-list" aria-label={`What ${name} can do`}>
          {SWITCHES.map((row) => <SwitchRow key={row.id} row={row} enabled={enabledOf(row.id)} saving={saving} onToggle={toggle} />)}
        </ul>
        <div className="owner-actions">
          <Button onClick={save} disabled={!changed || conflict} busy={saving}>Save changes</Button>
        </div>
        <h2 className="owner-cap-soon">Coming soon</h2>
        <ul className="owner-list owner-cap-list" aria-label={`Coming soon for ${name}`}>
          {COMING_SOON.map((label) => <li key={label} className="owner-cap-row owner-cap-row--soon"><strong>{label}</strong></li>)}
        </ul>
        <p className="owner-muted owner-cap-request">{'Something else? '}<AppLink to={`/app/agents/${agentId}/feedback?category=functionality`}>Request another capability</AppLink></p>
      </>}
    </>}
  </Shell>;
}
