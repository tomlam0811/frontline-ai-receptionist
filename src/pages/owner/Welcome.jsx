import { useEffect, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { AppLink, navigate } from './router.jsx';
import { Button, Notice, Shell, SignInPrompt, Tip } from '../../components/owner/ui.jsx';
import { usePageTitle } from '../../components/owner/hooks.js';
import { isSignedOut } from '../../components/owner/access.js';
import { useBobSummary } from '../../components/owner/BobFrame.jsx';
import FeedbackForm from '../../components/owner/FeedbackForm.jsx';
import ReceiptCard from '../../components/owner/ReceiptCard.jsx';
import { errorMessage } from './error-copy.js';
import { receptionistName } from '../../lib/receptionist-name.js';

// PO-S1. Shown once after a claim. Card A corrects what Bob knows (saved for the builder, then opened for
// review); Card B tells the builder. The cards are independent. Skip and continue both record the visit.

/** Card A. The text is saved for the builder (business_context), then a knowledge update is created and reviewed on the Knowledge screen. */
function CorrectionCard({ agentId, signIn, name }) {
  return <section className="owner-card owner-card--welcome" aria-labelledby="welcome-a-title">
    <h2 id="welcome-a-title">{`Correct what ${name} knows`}</h2>
    <p>{`Something missing or wrong about your business? Add it here. You review every change before ${name} uses it. The Frontline team can also see this message.`}</p>
    <FeedbackForm
      agentId={agentId}
      draftKey={`frontline.draft.knowledge.${agentId}.welcome`}
      textLabel={`What should ${name} know or correct?`}
      sendLabel="Review changes"
      fixedCategory="business_context"
      signIn={signIn}
      afterSend={async ({ key, text }) => {
        const summary = await ownerApi.getSummary(agentId);
        const created = await ownerApi.createKnowledgeUpdate(agentId, { inputType: 'text', text, baseAgentVersionId: summary.currentAgentVersionId, expectedPointerGeneration: summary.pointerGeneration }, `${key}_update`);
        await ownerApi.recordFirstVisit(agentId, 'continued').catch(() => {});
        navigate(`/app/knowledge?agent=${agentId}&update=${encodeURIComponent(created.update.updateId)}&notice=feedback_saved`);
      }}
      afterFailure={() => "Message saved for the Frontline team, but the changes to review couldn't be prepared. Text still in the box. Try again."}
    />
  </section>;
}

/** Card B. Feedback for the builder. It never changes Bob. */
function BuilderCard({ agentId, signIn, name }) {
  const [receipt, setReceipt] = useState(null);
  return <section className="owner-card owner-card--welcome" aria-labelledby="welcome-b-title">
    <h2 id="welcome-b-title">Tell the Frontline team</h2>
    <p>{`How ${name} sounded, what felt off, or something ${name} couldn't do. This goes to the Frontline team.`}</p>
    {receipt
      ? <ReceiptCard receipt={receipt} action={<div className="owner-actions"><Button variant="secondary" onClick={() => setReceipt(null)}>Send another message</Button></div>}>Thanks. The Frontline team will read it.</ReceiptCard>
      : <FeedbackForm agentId={agentId} draftKey={`frontline.draft.feedback.${agentId}.welcome`} textLabel="What should work better?" onSent={({ receipt: sent }) => setReceipt(sent)} signIn={signIn} />}
  </section>;
}

export default function Welcome({ agentId, signIn }) {
  const bob = useBobSummary(agentId);
  const [leaving, setLeaving] = useState(/** @type {null|'skipped'|'continued'} */ (null));
  const [leaveError, setLeaveError] = useState(/** @type {any} */ (null));
  const seen = bob.summary?.firstVisit?.seen === true;
  const unfinished = bob.access === 'unfinished' || (bob.access === 'ok' && bob.summary?.ready === false);
  const ready = bob.status === 'ready' && bob.access === 'ok' && !seen && !unfinished;
  usePageTitle('Welcome', bob.status !== 'loading' && !seen);

  // Shown once: a visit already recorded goes to Bob.
  useEffect(() => { if (seen) navigate(`/app/agents/${agentId}`, { replace: true }); }, [seen, agentId]);

  async function finish(outcome) {
    setLeaving(outcome); setLeaveError(null);
    try {
      await ownerApi.recordFirstVisit(agentId, outcome);
      navigate('/app');
    } catch (error) {
      setLeaving(null);
      setLeaveError((await isSignedOut(error)) ? { code: 'sign_in_required' } : error);
    }
  }

  const name = receptionistName(bob.summary ?? bob.workspace);
  const recoveryPath = bob.access === 'unfinished' ? `/app/workspaces/${agentId}/setup` : `/app/agents/${agentId}/setup`;
  return <Shell>
    {(bob.status === 'loading' || seen) && <h1 aria-live="polite">Opening your receptionist…</h1>}
    {bob.status === 'error' && <><h1>Opening your receptionist…</h1><Notice kind="error" title="Couldn't open your receptionist." action={<Button variant="secondary" onClick={bob.reload}>Try again</Button>}>{errorMessage(bob.error)}</Notice></>}
    {bob.status === 'ready' && bob.access === 'signedOut' && <SignInPrompt onSignIn={signIn} />}
    {bob.status === 'ready' && bob.access === 'missing' && <><h1>Couldn&apos;t find that receptionist.</h1><AppLink className="bob-button bob-button--primary" to="/app">Open receptionist</AppLink></>}
    {bob.status === 'ready' && !seen && unfinished && <>
      <h1>{`${name} needs your business details.`}</h1>
      <AppLink className="bob-button bob-button--primary" to={recoveryPath}>Add business details</AppLink>
    </>}
    {ready && <>
      <h1>{`How was the conversation with ${name}?`}</h1>
      <Tip>Tell us what worked, what felt off, or what was missing.</Tip>
      <CorrectionCard agentId={agentId} signIn={signIn} name={name} />
      <BuilderCard agentId={agentId} signIn={signIn} name={name} />
      {leaveError && (leaveError.code === 'sign_in_required'
        ? <Notice kind="warning" action={<Button onClick={signIn}>Sign in</Button>}>Sign in again to continue.</Notice>
        : <Notice kind="error" title="Couldn't save that choice.">{errorMessage(leaveError)}</Notice>)}
      <div className="owner-welcome-footer">
        <button type="button" className="owner-text-button" disabled={leaving !== null} onClick={() => finish('skipped')}>{leaving === 'skipped' ? 'Skipping…' : 'Skip for now'}</button>
        <AppLink className="bob-button bob-button--primary" to="/app" aria-disabled={leaving !== null || undefined} onClick={(event) => { event.preventDefault(); if (leaving === null) finish('continued'); }}>{`Continue to ${name}`}</AppLink>
      </div>
    </>}
  </Shell>;
}
