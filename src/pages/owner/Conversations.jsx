import { useEffect, useRef, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { AppLink } from './router.jsx';
import { BackButton, Button, EmptyState, InlineError, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { withSessionCheck } from '../../components/owner/access.js';
import { AccessGate, BackToBob, useBobSummary } from '../../components/owner/BobFrame.jsx';
import { ConversationRow, ORIGIN_LABEL, conversationStatus, versionText } from '../../components/owner/ConversationRow.jsx';
import ConversationOutcomes from '../../components/owner/ConversationOutcomes.jsx';
import ShareDialog from '../../components/owner/ShareDialog.jsx';
import TranscriptView from '../../components/owner/TranscriptView.jsx';
import CallSummary from '../../components/product/CallSummary.jsx';
import { recordNotes, unrecordedTasks } from '../../components/product/ReviewNote.jsx';
import { formatDateTime, formatDuration } from './format.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import '../../components/owner/conversations.css';

// PO-S10. The owner's conversations with the receptionist: a list newest first with "Load more", and one conversation's
// summary, outcomes and transcript. The only write is marking a Needs review note done (VA-D13). Another owner's
// conversation and an unknown id look the same.

function SignInPrompt({ signIn }) {
  return <><h1>Sign in to see your conversations.</h1><Button onClick={signIn}>Sign in</Button></>;
}

function ConversationList({ agentId, signIn, name, summary, reloadSummary }) {
  const [sharing, setSharing] = useState(false);
  const first = useLoad((signal) => withSessionCheck(() => ownerApi.listConversations(agentId, {}, signal), signal), [agentId]);
  const [more, setMore] = useState(/** @type {{rows: any[], cursor: string|null|undefined, busy: boolean, failed: boolean, focusId: string|null}} */ ({ rows: [], cursor: undefined, busy: false, failed: false, focusId: null }));
  const focusTarget = useRef(/** @type {HTMLAnchorElement|null} */ (null));
  const rows = [...(first.data?.conversations ?? []), ...more.rows];
  const cursor = more.cursor === undefined ? (first.data?.nextCursor ?? null) : more.cursor;
  const signedOut = first.error?.code === 'sign_in_required';
  usePageTitle('Conversations', first.status !== 'loading');

  useEffect(() => { if (more.focusId) focusTarget.current?.focus(); }, [more.focusId]);

  async function loadMore() {
    setMore((current) => ({ ...current, busy: true, failed: false }));
    try {
      const page = await ownerApi.listConversations(agentId, { cursor });
      const known = new Set(rows.map((row) => row.conversationId));
      const fresh = page.conversations.filter((row) => !known.has(row.conversationId));
      setMore((current) => ({ rows: [...current.rows, ...fresh], cursor: page.nextCursor ?? null, busy: false, failed: false, focusId: fresh[0]?.conversationId ?? null }));
    } catch {
      // The rows already shown stay; the same button tries again.
      setMore((current) => ({ ...current, busy: false, failed: true }));
    }
  }

  if (signedOut) return <SignInPrompt signIn={signIn} />;
  return <>
    <BackToBob agentId={agentId} name={name} />
    <h1>Conversations</h1>
    <p className="owner-lede">Conversations are kept for 30 days.</p>
    {first.status === 'loading' && <Loading>Loading conversations…</Loading>}
    {first.status === 'error' && <Notice kind="error" title="Couldn't load conversations." action={<Button variant="secondary" onClick={first.reload}>Try again</Button>} />}
    {first.status === 'ready' && rows.length === 0 && <EmptyState title="No conversations yet." action={<div className="owner-actions">
      <AppLink className="bob-button bob-button--primary" to={`/app/agents/${agentId}/talk`} state={{ startCall: true }}>{`Talk to ${name}`}</AppLink>
      <Button variant="secondary" onClick={() => setSharing(true)}>Share</Button>
    </div>}>{`Your calls with ${name} and calls from shared links appear here.`}</EmptyState>}
    {rows.length > 0 && <>
      <ul className="owner-list" aria-label="Conversations">
        {rows.map((item) => <ConversationRow key={item.conversationId} agentId={agentId} item={item} ref={item.conversationId === more.focusId ? focusTarget : undefined} />)}
      </ul>
      {more.busy && <Loading>Loading more…</Loading>}
      <InlineError>{more.failed ? "Couldn't load more. Try again." : ''}</InlineError>
      {cursor && <div className="owner-actions"><Button variant="secondary" onClick={loadMore} disabled={more.busy}>Load more</Button></div>}
    </>}
    {sharing && summary && <ShareDialog agentId={agentId} summary={summary} onClose={() => setSharing(false)} onStale={reloadSummary} signIn={signIn} />}
  </>;
}

function Summary({ recap, summary, outcomes }) {
  if (recap) return <section className="owner-summary" aria-label="Summary"><h2>Summary</h2><p className="owner-recap">{recap}</p></section>;
  const empty = !summary || ((summary.tasks?.length ?? 0) === 0 && (summary.callerExcerpts?.length ?? 0) === 0);
  if (empty) return <section className="owner-summary" aria-label="Summary"><h2>Summary</h2><p className="owner-summary-empty">There isn&apos;t enough in this conversation to summarize.</p></section>;
  // A request with a saved note is shown once, under Outcomes.
  const shownBelow = (summary.callerExcerpts?.length ?? 0) === 0 && unrecordedTasks(summary.tasks, recordNotes(outcomes)).length === 0;
  if (shownBelow) return null;
  return <div className="owner-summary"><CallSummary summary={summary} listedSeparately={outcomes} /></div>;
}

function ConversationDetail({ agentId, conversationId, currentAgentVersionId, signIn }) {
  const load = useLoad((signal) => withSessionCheck(() => ownerApi.getConversation(agentId, conversationId, signal), signal), [agentId, conversationId]);
  const signedOut = load.error?.code === 'sign_in_required';
  // Expired, deleted, another owner's and unknown ids are one state: no distinction is shown.
  const gone = load.status === 'error' && [404, 410].includes(load.error?.status);
  usePageTitle('Conversation', load.status !== 'loading');
  const listPath = `/app/agents/${agentId}/conversations`;
  const back = <BackButton to={listPath} label="Back to conversations" />;
  if (signedOut) return <SignInPrompt signIn={signIn} />;
  if (load.status === 'loading') return <>{back}<h1>Conversation</h1><Loading>Loading conversation…</Loading></>;
  if (gone) return <>{back}<h1>This conversation is no longer available.</h1></>;
  if (load.status === 'error') return <>{back}<h1>Conversation</h1><Notice kind="error" title="Couldn't load this conversation." action={<Button variant="secondary" onClick={load.reload}>Try again</Button>} /></>;
  const detail = load.data;
  const status = conversationStatus(detail.state, detail.terminalReason, detail.requestLeftOpen);
  const duration = formatDuration(detail.durationSeconds);
  return <>
    {back}
    <h1>{ORIGIN_LABEL[detail.origin] ?? 'Conversation'}, {formatDateTime(detail.startedAt)}</h1>
    <p className="owner-detail-meta">
      {duration && <span>{duration}</span>}
      <span className={`owner-chip owner-chip--${status.tone}`}><span aria-hidden="true">{status.icon}</span> {status.label}</span>
      {versionText(detail, currentAgentVersionId) && <span>{versionText(detail, currentAgentVersionId)}</span>}
    </p>
    <Summary recap={detail.recap} summary={detail.summary} outcomes={detail.outcomes} />
    <ConversationOutcomes outcomes={detail.outcomes} agentId={agentId} conversationId={detail.conversationId} />
    <TranscriptView transcript={detail.transcript} notice={detail.transcriptNotice} origin={detail.origin} />
    <div className="owner-actions">
      <AppLink className="bob-button bob-button--secondary" to={`/app/agents/${agentId}/feedback?conversation=${encodeURIComponent(detail.conversationId)}`}>Give feedback about this conversation</AppLink>
    </div>
  </>;
}

/** `conversationId` is set on the detail route. */
export default function Conversations({ agentId, conversationId = null, signIn }) {
  const bob = useBobSummary(agentId);
  const blocked = bob.status === 'error' || (bob.status === 'ready' && bob.access !== 'ok');
  const currentAgentVersionId = bob.summary?.currentAgentVersionId ?? null;
  const name = receptionistName(bob.summary);
  return <Shell wide>
    {bob.status === 'loading' && <Loading>Loading conversations…</Loading>}
    {blocked && <AccessGate bob={bob} signIn={signIn} />}
    {bob.status === 'ready' && bob.access === 'ok' && (conversationId
      ? <ConversationDetail agentId={agentId} conversationId={conversationId} currentAgentVersionId={currentAgentVersionId} signIn={signIn} />
      : <ConversationList agentId={agentId} signIn={signIn} name={name} summary={bob.summary} reloadSummary={bob.reload} />)}
  </Shell>;
}
