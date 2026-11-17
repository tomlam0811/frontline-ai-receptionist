import { useState } from 'react';
import { AppLink, navigate } from './router.jsx';
import { ownerApi } from '../../lib/owner-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import { BackButton, Button, ConfirmDialog, Loading, MenuItem, Notice, OverflowMenu, Shell } from '../../components/owner/ui.jsx';
import { usePageTitle } from '../../components/owner/hooks.js';
import { AccessGate, BobIdentity, callBlocker, needsKnowledgeReason, useBobSummary } from '../../components/owner/BobFrame.jsx';
import RenameDialog from '../../components/owner/RenameDialog.jsx';
import ShareDialog from '../../components/owner/ShareDialog.jsx';
import { errorMessage } from './error-copy.js';
import './bob.css';

// PO-S9. Receptionist detail: identity card with the one primary action (Talk) and a menu for Rename, Pause, Share, Give feedback and Delete,
// then one identical link card each for Knowledge, Capabilities and Conversations.

/**
 * One card on the receptionist page: a title, one muted line, and the whole card is the link.
 * @param {{to: string, title: string, children: any}} props
 */
function SectionCard({ to, title, children }) {
  return <AppLink className="owner-link-card" to={to}><h2 className="owner-link-card__title">{title}</h2><span>{children}</span></AppLink>;
}

/** @param {any} props `shareOpen` opens the Share dialog on arrival, for the /share address. */
export default function Bob({ agentId, signIn, shareOpen = false }) {
  const bob = useBobSummary(agentId);
  const [sharing, setSharing] = useState(shareOpen);
  const [renaming, setRenaming] = useState(false);
  const [pausing, setPausing] = useState({ open: false, busy: false, error: '' });
  const [resuming, setResuming] = useState({ busy: false, error: '' });
  const [deleting, setDeleting] = useState({ open: false, busy: false, error: '' });
  const name = receptionistName(bob.summary ?? bob.workspace);
  usePageTitle(bob.summary ? name : 'Receptionist', bob.status !== 'loading');
  const gate = <AccessGate bob={bob} signIn={signIn} />;
  const blocked = bob.status === 'error' || (bob.status === 'ready' && bob.access !== 'ok');
  const summary = bob.summary;
  const blocker = summary ? callBlocker(summary) : null;
  const noKnowledge = needsKnowledgeReason(summary);
  const base = `/app/agents/${agentId}`;
  const paused = summary?.status === 'paused';
  const pause = async () => {
    setPausing({ open: true, busy: true, error: '' });
    try { await ownerApi.pauseAgent(agentId); setPausing({ open: false, busy: false, error: '' }); bob.reload(); }
    catch (error) { setPausing({ open: true, busy: false, error: errorMessage(error, { fallback: `Couldn't pause ${name}. Try again.` }) }); }
  };
  const resume = async () => {
    setResuming({ busy: true, error: '' });
    try { await ownerApi.resumeAgent(agentId); setResuming({ busy: false, error: '' }); bob.reload(); }
    catch (error) { setResuming({ busy: false, error: errorMessage(error, { fallback: `Couldn't resume ${name}. Try again.` }) }); }
  };
  // The page stays in its busy state until Home opens, so the button cannot be pressed twice.
  const remove = async () => {
    setDeleting({ open: true, busy: true, error: '' });
    try { await ownerApi.deleteAgent(agentId); navigate('/app'); }
    catch (error) { setDeleting({ open: true, busy: false, error: errorMessage(error, { fallback: `Couldn't delete ${name}. Try again.` }) }); }
  };
  const closeShare = () => { setSharing(false); if (shareOpen) navigate(base, { replace: true }); };
  return <Shell wide>
    {bob.status === 'loading' && <><h1>Receptionist</h1><Loading>Loading your receptionist…</Loading></>}
    {blocked && <>
      {gate}
      {bob.access === 'unfinished' && <div className="owner-actions"><button type="button" className="bob-button bob-button--secondary" disabled>{`Talk to ${name}`}</button></div>}
    </>}
    {summary && <>
      <BackButton to="/app" label="Back to Home" />
      <div className="owner-bob">
        <div className="owner-bob__side">
          <BobIdentity summary={summary} menu={<OverflowMenu>
            <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
            {paused
              ? <MenuItem disabled={resuming.busy || Boolean(noKnowledge)} onClick={resume}>Resume</MenuItem>
              : <MenuItem onClick={() => setPausing({ open: true, busy: false, error: '' })}>Pause</MenuItem>}
            <MenuItem disabled={Boolean(blocker)} onClick={() => setSharing(true)}>Share</MenuItem>
            <MenuItem to={`${base}/feedback`}>Give feedback</MenuItem>
            <hr className="owner-menu__separator" />
            <MenuItem className="owner-menu__item owner-menu__item--danger" onClick={() => setDeleting({ open: true, busy: false, error: '' })}>Delete</MenuItem>
          </OverflowMenu>}>
            {blocker
              ? <><button type="button" className="bob-button bob-button--primary owner-identity__talk" disabled aria-describedby="owner-action-reason">{`Talk to ${name}`}</button><p id="owner-action-reason" className="owner-muted">{blocker}</p>{paused && noKnowledge && <p id="owner-resume-reason" className="owner-muted">{noKnowledge}</p>}{(noKnowledge || paused) && <div className="owner-actions">
                {noKnowledge && <AppLink className="bob-button bob-button--secondary bob-button--small" to={`${base}/knowledge`}>Choose sources</AppLink>}
                {paused && <Button variant="secondary" onClick={resume} busy={resuming.busy} disabled={Boolean(noKnowledge)} aria-describedby={noKnowledge ? 'owner-resume-reason' : undefined}>Resume</Button>}
              </div>}</>
              : <AppLink className="bob-button bob-button--primary owner-identity__talk" to={`${base}/talk`} state={{ startCall: true }}>{`Talk to ${name}`}</AppLink>}
          </BobIdentity>
          <p className="owner-muted">{'Ready for real calls? '}<AppLink to={`${base}/feedback?topic=phone`}>Contact the Frontline team</AppLink>{` to set up a phone number for ${name}.`}</p>
          {resuming.error && <Notice kind="error" title={resuming.error} action={null} />}
          {!summary.ready && <Notice kind="error" title={`${name} can't take calls right now.`} action={null} />}
          {summary.knowledgeState === 'processing' && <Notice title="Saving your changes." action={null}>Check progress in Knowledge.</Notice>}
        </div>
        <div className="owner-bob__main">
          <SectionCard to={`${base}/knowledge`} title="Knowledge">{`What ${name} knows about your business.`}</SectionCard>
          <SectionCard to={`${base}/capabilities`} title="Capabilities">{`What ${name} can do.`}</SectionCard>
          <SectionCard to={`${base}/conversations`} title="Conversations">Call summaries and transcripts.</SectionCard>
        </div>
      </div>
      {renaming && <RenameDialog agentId={agentId} summary={summary} onClose={() => setRenaming(false)} onSaved={() => { setRenaming(false); bob.reload(); }} />}
      {pausing.open && <ConfirmDialog title={`Pause ${name}?`} body={`${name} stops taking calls and shared links stop working. Unused links are revoked. Conversations stay available. After you resume ${name}, create new links.`} confirmLabel="Pause" busy={pausing.busy} error={pausing.error} onConfirm={pause} onCancel={() => setPausing({ open: false, busy: false, error: '' })} />}
      {deleting.open && <ConfirmDialog title={`Delete ${name}?`} body={`This deletes ${name}, its conversations and its shared links. This can't be undone.`} confirmLabel={`Delete ${name}`} busy={deleting.busy} error={deleting.error} onConfirm={remove} onCancel={() => setDeleting({ open: false, busy: false, error: '' })} />}
      {sharing && !paused && <ShareDialog agentId={agentId} summary={summary} onClose={closeShare} onStale={bob.reload} signIn={signIn} />}
    </>}
  </Shell>;
}
