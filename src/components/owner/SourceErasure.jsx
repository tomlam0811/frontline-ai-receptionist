import { Fragment, useEffect, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { Button, ConfirmDialog, Notice } from './ui.jsx';
import { joinNames, nameOf, typeName } from './source-names.js';
import SourceRow from './SourceRow.jsx';
import { errorMessage, isConflict } from '../../pages/owner/error-copy.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import { pollSettings } from './KnowledgeParts.jsx';

/** "website" or "typed note": the kind of source, for button labels that name what they remove. */
const kindOf = (source) => typeName(source.type).toLowerCase();
/** What a Remove button says out loud: the kind, and the source's own name when it has one. */
const removeLabel = (source) => `Remove ${kindOf(source)}${source.label ? `: ${source.label}` : ''}`;

/** The receptionists that use a source, by name. `agentId` is the receptionist this page acts through. */
const namesOf = (source, agentId) => {
  const users = source.usedBy ?? [];
  return { others: users.filter((user) => user.stableAgentId !== agentId).map((user) => user.name), usesIt: users.some((user) => user.stableAgentId === agentId) };
};

/** What the confirmation says about who stops using the source. Removing erases it for every receptionist. */
function removeBody(source, agentId, name) {
  const { others, usesIt } = namesOf(source, agentId);
  if (!others.length) return `${name} will stop using it.`;
  const list = joinNames(others);
  return usesIt ? `${name} will stop using it. ${list} also ${others.length === 1 ? 'uses' : 'use'} this source.` : `${list} will stop using it.`;
}

/** @param {any} props `factCounts` is a Map of source id to its number of facts. */
export function SourceErasure({ agentId, sources, jobs, pointerGeneration, onChanged, name = receptionistName(), factCounts = new Map() }) {
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryError, setRetryError] = useState('');
  const [removed, setRemoved] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const unfinished = jobs.some((job) => job.status === 'pending');

  useEffect(() => {
    if (!unfinished) return undefined;
    const timer = setTimeout(onChanged, pollSettings.intervalMs);
    return () => clearTimeout(timer);
  }, [unfinished, jobs, onChanged]);

  const gone = new Set([...hidden, ...jobs.map((job) => job.sourceId)]);
  const rows = sources.filter((source) => !gone.has(source.sourceId));
  const failed = jobs.filter((job) => job.status === 'failed');

  async function remove(source) {
    setBusy(true); setError('');
    try {
      await ownerApi.eraseSource(agentId, source.sourceId, pointerGeneration);
      setHidden((current) => new Set(current).add(source.sourceId));
      setRemoved(nameOf(source));
      setTarget(null); onChanged();
    } catch (failure) {
      if (isConflict(failure)) onChanged();
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  async function retry(job) {
    setRetryError('');
    try { await ownerApi.eraseSource(agentId, job.sourceId, pointerGeneration); onChanged(); } catch (failure) { setRetryError(errorMessage(failure)); }
  }

  if (!rows.length && !failed.length && !removed) return null;
  return <section className="owner-sources" aria-label="Sources">
    <h2>Sources</h2>
    {removed && <Notice kind="info" title={`${removed} removed.`} action={null} />}
    {failed.map((job) => {
      const sourceName = nameOf(sources.find((source) => source.sourceId === job.sourceId) ?? { type: job.sourceType });
      return <Fragment key={job.jobId}><Notice kind="warning" title={`Couldn't finish removing ${sourceName}.`} action={<Button variant="secondary" onClick={() => retry(job)}>Try again</Button>}>{`${name} has stopped using it. Try again to finish.`} {retryError}</Notice></Fragment>;
    })}
    {rows.length > 0 && <ul className="owner-source-list" aria-label="Sources">
      {rows.map((source) => <SourceRow key={source.sourceId} source={source} detailCount={factCounts.get(source.sourceId) ?? 0} usedBy={(source.usedBy ?? []).map((user) => user.name)}
        action={<button type="button" className="owner-source-row__action" aria-label={removeLabel(source)} onClick={() => { setError(''); setTarget(source); }}>Remove</button>} />)}
    </ul>}
    {target && <ConfirmDialog title={`Remove ${nameOf(target)}?`}
      body={removeBody(target, agentId, name)}
      confirmLabel={`Remove ${kindOf(target)}`} busy={busy} error={error} onCancel={() => setTarget(null)} onConfirm={() => remove(target)} />}
  </section>;
}
