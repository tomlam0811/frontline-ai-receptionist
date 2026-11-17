import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ownerApi, newKey } from '../../lib/owner-api.js';
import { uploadKnowledgeDocument } from '../../lib/owner-uploads.js';
import { Button, ConfirmDialog, Dialog, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { SourceErasure } from '../../components/owner/SourceErasure.jsx';
import { AccessGate, AppliedBanner, ConflictNotice, useBobSummary } from '../../components/owner/BobFrame.jsx';
import {
  AddChooser, DocumentPanel, FactEditor, GROUP_OF_CATEGORY, KnowledgeCategory, MissingList, ProcessingStatus, Recorder, ResolveDialog, ReviewChanges, TypePanel, UrlPanel,
  ADD_LABEL, METHOD_LABEL, MISSING_LABEL, documentProblem, failureMessage, fieldMessage, pollSettings,
} from '../../components/owner/KnowledgeParts.jsx';
import { errorMessage, isConflict } from './error-copy.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import { countFactsBySource } from '../../components/owner/source-names.js';
import './knowledge.css';

// PO-S3. Knowledge: sources first, then the saved details by category, then a short list of what is missing.
// Everything is added through one "Add knowledge" button: a chooser, then a form or upload in a dialog.
// A review section must be applied before anything changes. Success is shown only after the API returns it.

const CATEGORY_KEYS = ['business_details', 'services', 'hours', 'locations_service_area', 'pricing', 'policies', 'faqs', 'other'];
const RUNNING = ['extracting', 'needs_confirmation', 'applying'];

/** A request key that stays the same while the payload does, so a retry is a replay and a changed payload is a new action. */
function useRequestKey() {
  const held = useRef({ payload: '', key: '' });
  return {
    keyFor(payload) {
      const serialized = JSON.stringify(payload);
      if (held.current.payload !== serialized) held.current = { payload: serialized, key: newKey() };
      return held.current.key;
    },
    reset() { held.current = { payload: '', key: '' }; },
  };
}

/**
 * @param {any} props `basePath` is the address the open category is recorded under. `lede` replaces the one-line
 * description "What [Name] knows" when the library is shared by several receptionists.
 */
export default function Knowledge({ agentId, category, signIn, notice, lede = null, basePath = '/app/knowledge' }) {
  const bob = useBobSummary(agentId);
  const ok = bob.access === 'ok';
  const knowledge = useLoad((signal) => (ok ? ownerApi.getKnowledge(agentId, signal) : Promise.resolve(null)), [agentId, ok]);
  const version = bob.summary?.versionNumber ?? null;
  const name = receptionistName(bob.summary);

  const [work, setWork] = useState(null);
  const [applied, setApplied] = useState(null);
  const [workError, setWorkError] = useState(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [panel, setPanel] = useState(null);
  const [drafts, setDrafts] = useState({ text: '', url: '', file: null });
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [editor, setEditor] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [resolving, setResolving] = useState(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [expired, setExpired] = useState(false);
  const [open, setOpen] = useState(() => new Set(CATEGORY_KEYS.includes(category) ? [category] : []));
  const urlCategory = useRef(category);
  const resumed = useRef(false);
  const createKey = useRequestKey();
  const applyKey = useRequestKey();

  const groups = useMemo(() => knowledge.data?.categories ?? [], [knowledge.data]);
  const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const sources = useMemo(() => new Map((knowledge.data?.sources ?? []).map((source) => [source.sourceId, source])), [knowledge.data]);
  const factCounts = useMemo(() => countFactsBySource(groups), [groups]);
  const inputs = knowledge.data?.inputs ?? {};
  const update = work?.update ?? null;
  const locked = Boolean(update);
  const removing = useMemo(() => new Set((update?.state === 'review' ? update.candidates : []).filter((candidate) => candidate.action === 'remove').map((candidate) => candidate.targetEntryId)), [update]);
  usePageTitle('Knowledge', bob.status !== 'loading' && (!ok || knowledge.status !== 'loading'));

  // An update left open (another tab, or a reload) comes back exactly where it was.
  useEffect(() => {
    if (resumed.current || !knowledge.data) return;
    resumed.current = true;
    const [latest] = knowledge.data.openUpdates ?? [];
    if (latest) setWork({ update: latest });
  }, [knowledge.data]);

  // Poll a running update. An unchanged state changes nothing on screen, so nothing is announced again.
  useEffect(() => {
    if (!update || !RUNNING.includes(update.state) || pollFailed) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { update: latest } = await ownerApi.getKnowledgeUpdate(agentId, update.updateId, controller.signal);
        if (!controller.signal.aborted) setWork((current) => (current?.update.updateId === latest.updateId ? { update: latest } : current));
      } catch (error) {
        if (error?.name !== 'AbortError' && !controller.signal.aborted) setPollFailed(true);
      }
    }, pollSettings.intervalMs);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [work, update, pollFailed, agentId]);

  // Candidates arrive with a new source; the list of sources is read again so the evidence can name it.
  const reloadKnowledge = knowledge.reload;
  const reloadBob = bob.reload;
  const refreshAfterErasure = useCallback(() => { reloadKnowledge(); reloadBob(); }, [reloadKnowledge, reloadBob]);
  const state = update?.state;
  useEffect(() => { if (state === 'review') reloadKnowledge(); }, [state, reloadKnowledge]);
  useEffect(() => { if (state === 'cancelled' || state === 'applied') setWork(null); }, [state]);
  // What the owner typed is kept until it has been read, so a failed read can be tried again without retyping.
  useEffect(() => { if (state === 'review') setDrafts({ text: '', url: '', file: null }); }, [state]);

  function noteAuth(failure) { if (failure?.status === 401 || failure?.code === 'sign_in_required') setExpired(true); }

  /** Creates an update from the current page base. A stale base reloads what the page shows and rethrows for the caller to display. */
  async function createUpdate(fields) {
    const key = createKey.keyFor(fields);
    try {
      const { update: created } = await ownerApi.createKnowledgeUpdate(agentId, { ...fields, baseAgentVersionId: knowledge.data.currentAgentVersionId, expectedPointerGeneration: knowledge.data.pointerGeneration }, key);
      createKey.reset();
      setApplied(null); setApplyError(null); setWorkError(null); setPollFailed(false);
      setWork({ update: created });
      reloadKnowledge();
      return created;
    } catch (failure) {
      noteAuth(failure);
      if (isConflict(failure)) { reloadKnowledge(); bob.reload(); }
      throw failure;
    }
  }

  async function runPanel(fn) {
    setPanelBusy(true); setPanelError('');
    try {
      await fn();
      setPanel(null); setAddOpen(false);
    } catch (failure) { setPanelError(fieldMessage(failure)); } finally { setPanelBusy(false); }
  }
  const submitText = () => (drafts.text.trim() ? runPanel(() => createUpdate({ inputType: 'text', text: drafts.text })) : setPanelError('Write something first.'));
  const submitUrl = () => {
    const address = drafts.url.trim();
    if (!/^https:\/\//i.test(address)) { setPanelError(errorMessage({ code: 'source_not_public' })); return; }
    return runPanel(() => createUpdate({ inputType: 'url', url: address }));
  };
  const submitDocument = () => {
    if (!drafts.file) { setPanelError('Choose a file first.'); return; }
    return runPanel(async () => createUpdate({ inputType: 'document', uploadHandle: await uploadKnowledgeDocument(agentId, drafts.file) }));
  };
  const chooseFile = (file) => { setDrafts((current) => ({ ...current, file })); const code = documentProblem(file); setPanelError(code ? errorMessage({ code }) : ''); };
  const chooseMethod = (method) => { setPanel(method); setPanelError(''); };
  const openAdd = () => { setAddOpen(true); setPanel(null); setPanelError(''); };
  const closeAdd = () => { setAddOpen(false); setPanel(null); setPanelError(''); };
  const addDetail = (group) => { closeAdd(); setEditor({ mode: 'add', group }); };

  async function cancelUpdate() {
    setCancelling(true); setWorkError(null);
    try { await ownerApi.cancelKnowledgeUpdate(agentId, update.updateId, update.version); setWork(null); } catch (failure) { noteAuth(failure); setWorkError(failure); } finally { setCancelling(false); }
  }

  async function apply(decisions, target) {
    setApplyBusy(true); setApplyError(null);
    const key = applyKey.keyFor({ updateId: target.updateId, version: target.version, decisions });
    try {
      await ownerApi.applyKnowledgeUpdate(agentId, target.updateId, { expectedVersion: target.version, decisions }, key);
      applyKey.reset();
      setWork(null);
      reloadKnowledge(); bob.reload();
      // The apply already succeeded above; a refresh that fails here must not report it as an error.
      const fresh = await ownerApi.getSummary(agentId).catch(() => null);
      setApplied({ version: fresh?.versionNumber ?? (version ?? 0) + 1 });
    } catch (failure) {
      noteAuth(failure);
      if (isConflict(failure)) {
        const latest = await ownerApi.getKnowledgeUpdate(agentId, target.updateId).then((result) => result.update, () => null);
        if (latest) setWork({ update: latest });
        reloadKnowledge(); bob.reload();
      } else setApplyError(failure);
    } finally { setApplyBusy(false); }
  }

  async function reviewAgain() {
    setConflictBusy(true);
    try { const { update: reopened } = await ownerApi.reopenKnowledgeUpdate(agentId, update.updateId); setWork({ update: reopened }); reloadKnowledge(); bob.reload(); } catch (failure) { setWorkError(failure); } finally { setConflictBusy(false); }
  }
  async function discardConflict() {
    setConflictBusy(true);
    try { await ownerApi.cancelKnowledgeUpdate(agentId, update.updateId, update.version); setWork(null); reloadKnowledge(); bob.reload(); } catch (failure) { setWorkError(failure); } finally { setConflictBusy(false); }
  }

  async function confirmDelete() {
    setDeleteBusy(true); setDeleteError('');
    try { await createUpdate({ inputType: 'form', op: 'remove', group: deleting.group, targetEntryId: deleting.entryId }); setDeleting(null); } catch (failure) { setDeleteError(fieldMessage(failure)); } finally { setDeleteBusy(false); }
  }
  async function chooseKept(keptId) {
    const other = resolving.find((entry) => entry.entryId !== keptId);
    setResolveBusy(true); setResolveError('');
    try { await createUpdate({ inputType: 'form', op: 'remove', group: other.group, targetEntryId: other.entryId }); setResolving(null); } catch (failure) { setResolveError(fieldMessage(failure)); } finally { setResolveBusy(false); }
  }

  function toggleCategory(key, isOpen) {
    setOpen((current) => {
      if (current.has(key) === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(key); else next.delete(key);
      return next;
    });
    // The address records the category last opened, so a reload or Back returns to it. It is written directly
    // because a route change would remount the screen and lose an open review.
    if (isOpen && urlCategory.current !== key) {
      urlCategory.current = key;
      try { window.history.pushState({}, '', `${basePath}/${key}`); } catch { /* the address is a convenience */ }
    }
  }
  function conflictSet(entry) {
    const byId = new Map(entries.map((item) => [item.entryId, item]));
    return [entry, ...entry.conflictWithEntryIds.map((id) => byId.get(id)).filter(Boolean)];
  }
  function tryAgain() {
    const method = update.inputType === 'dictation' ? 'text' : update.inputType;
    setWork(null); setPollFailed(false);
    setAddOpen(true); setPanel(method === 'form' ? null : method); setPanelError('');
  }
  function typeInstead() { setWork(null); setAddOpen(true); setPanel('text'); setPanelError(''); }

  const blocked = bob.status === 'error' || (bob.status === 'ready' && !ok);
  // A category with only facts Bob does not use stays listed, so those facts can still be read.
  const saved = groups.filter((group) => group.entries.length > 0 || group.notUsedByBob.length > 0);
  const missing = groups.filter((group) => group.entries.length === 0 && group.category in MISSING_LABEL);
  const backButtons = <>
    <Button variant="secondary" onClick={() => chooseMethod(null)} disabled={panelBusy}>Back</Button>
    <Button variant="secondary" onClick={closeAdd} disabled={panelBusy}>Cancel</Button>
  </>;
  const anyConflict = entries.some((entry) => entry.hasConflict);
  const failedOnUnavailable = update?.state === 'failed';
  return <Shell wide>
    {bob.status === 'loading' && <><h1>Knowledge</h1><Loading>Loading Knowledge…</Loading></>}
    {blocked && <AccessGate bob={bob} signIn={signIn} />}
    {ok && <>
      <div className="owner-page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="owner-lede">{lede ?? `What ${name} knows about your business.`}</p>
        </div>
        {knowledge.data && !update && <Button aria-haspopup="dialog" onClick={openAdd}>Add knowledge</Button>}
      </div>
      {expired && <Notice kind="warning" title="Sign in again to continue." action={<Button variant="secondary" onClick={signIn}>Sign in</Button>} />}
      {notice === 'feedback_saved' && <Notice kind="info">Message saved. Check the changes below.</Notice>}
      {knowledge.status === 'loading' && <Loading>Loading Knowledge…</Loading>}
      {knowledge.status === 'error' && <Notice kind="error" title="Couldn't load Knowledge." action={<Button variant="secondary" onClick={knowledge.reload}>Try again</Button>}>{errorMessage(knowledge.error)}</Notice>}
      {knowledge.data && <>
        {applied && !update && <AppliedBanner agentId={agentId} name={name} />}
        {anyConflict && <Notice kind="warning" title="Some items don't match." action={null}>{`Choose which one ${name} should use.`}</Notice>}
        {workError && <Notice kind="error" title="Couldn't finish that." action={null}>{errorMessage(workError)}</Notice>}

        {update && update.state === 'extracting' && <ProcessingStatus message="Reading what you added…" onCancel={cancelUpdate} cancelling={cancelling} />}
        {update && update.state === 'needs_confirmation' && <ProcessingStatus message="Reading what you added…" onCancel={cancelUpdate} cancelling={cancelling} />}
        {update && update.state === 'applying' && <ProcessingStatus message="Saving your changes…" />}
        {pollFailed && <Notice kind="error" title="Couldn't check progress." action={<Button variant="secondary" onClick={() => setPollFailed(false)}>Try again</Button>} />}
        {update && update.state === 'review' && <ReviewChanges key={`${update.updateId}:${update.version}`} update={update} entries={entries} sources={sources} name={name}
          busy={applyBusy} error={applyError ? errorMessage(applyError) : ''} onApply={apply} onCancel={cancelUpdate} />}
        {update && update.state === 'conflict' && <ConflictNotice name={name} busy={conflictBusy} onReview={reviewAgain} onDiscard={discardConflict} />}
        {failedOnUnavailable && <Notice kind="error" title="Couldn't add that." action={<div className="owner-actions">
          <Button variant="secondary" onClick={tryAgain}>Try again</Button>
          {inputs.text && update.inputType !== 'text' && <Button variant="secondary" onClick={typeInstead}>Type instead</Button>}
        </div>}>{failureMessage(update.failureCode)}</Notice>}

        {locked && update.state === 'review' && <p className="owner-muted">{"Finish or cancel the changes you're reviewing first."}</p>}

        {!update && <SourceErasure name={name} agentId={agentId} sources={knowledge.data.sources} jobs={knowledge.data.sourceErasures ?? []} factCounts={factCounts} pointerGeneration={knowledge.data.pointerGeneration}
          onChanged={refreshAfterErasure} />}
        {saved.length > 0 && <section className="owner-knowledge-section" aria-labelledby="knowledge-saved">
          <h2 id="knowledge-saved">Saved details</h2>
          <div className="owner-categories">
            {saved.map((group) => <KnowledgeCategory key={group.category} name={name} group={group} open={open.has(group.category)} onToggle={toggleCategory} locked={locked} removing={removing}
              onEdit={(entry) => setEditor({ mode: 'edit', group: groups.find((item) => item.category === entry.category), entry })}
              onDelete={setDeleting} onResolve={(entry) => { setResolveError(''); setResolving(conflictSet(entry)); }} />)}
          </div>
        </section>}
        {missing.length > 0 && <section className="owner-knowledge-section" aria-labelledby="knowledge-missing">
          <h2 id="knowledge-missing">Missing</h2>
          <MissingList groups={missing} locked={locked} onAdd={(group) => setEditor({ mode: 'add', group })} />
        </section>}
      </>}
      {addOpen && !panel && <AddChooser key="choose" groups={groups} inputs={inputs} onCategory={addDetail} onMethod={chooseMethod} onClose={closeAdd} />}
      {addOpen && panel && <Dialog key="method" title={METHOD_LABEL[panel]} onClose={closeAdd} busy={panelBusy}>
        {panel === 'text' && <TypePanel name={name} value={drafts.text} onChange={(text) => { setDrafts((current) => ({ ...current, text })); setPanelError(''); }} onSubmit={submitText} busy={panelBusy} error={panelError} after={backButtons} />}
        {panel === 'dictation' && <><Recorder agentId={agentId} busy={panelBusy} onTypeInstead={() => chooseMethod('text')} onUse={(text) => runPanel(() => createUpdate({ inputType: 'dictation', text }))} /><p className="owner-inline-error" role="alert">{panelError}</p><div className="owner-actions">{backButtons}</div></>}
        {panel === 'document' && <DocumentPanel file={drafts.file} onChoose={chooseFile} onSubmit={submitDocument} busy={panelBusy} error={panelError} after={backButtons} />}
        {panel === 'url' && <UrlPanel value={drafts.url} onChange={(url) => { setDrafts((current) => ({ ...current, url })); setPanelError(''); }} onSubmit={submitUrl} busy={panelBusy} error={panelError} after={backButtons} />}
      </Dialog>}
      {editor && <FactEditor
        title={editor.mode === 'add' ? ADD_LABEL[editor.group.category] : 'Edit this item'} categoryLabel={editor.group.label}
        hours={editor.group.category === 'hours'} hoursLocked={editor.mode === 'edit'}
        initial={editor.mode === 'edit' ? { value: editor.entry.value, scope: editor.entry.scope, group: editor.entry.group } : { value: '', scope: '', group: '' }}
        onClose={() => setEditor(null)}
        onSubmit={async ({ value, scope, group }) => {
          await createUpdate(editor.mode === 'edit'
            ? { inputType: 'form', op: 'replace', group: editor.entry.group, value, scope, targetEntryId: editor.entry.entryId }
            : { inputType: 'form', op: 'add', group: GROUP_OF_CATEGORY[editor.group.category] ?? group, value, scope });
          setEditor(null);
        }} />}
      {deleting && <ConfirmDialog title="Remove this item?" body={`${name} will stop using it once you apply the change. Earlier calls and shared links aren't changed.`} confirmLabel="Remove item"
        busy={deleteBusy} error={deleteError} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />}
      {resolving && <ResolveDialog name={name} entries={resolving} busy={resolveBusy} error={resolveError} onClose={() => setResolving(null)} onChoose={chooseKept} />}
    </>}
  </Shell>;
}
