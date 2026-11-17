import { useMemo, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { AppLink } from './router.jsx';
import { Button, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { withSessionCheck } from '../../components/owner/access.js';
import { BackToBob } from '../../components/owner/BobFrame.jsx';
import FeedbackForm, { FEEDBACK_CATEGORIES } from '../../components/owner/FeedbackForm.jsx';
import ReceiptCard from '../../components/owner/ReceiptCard.jsx';
import { formatDateTime } from './format.js';
import { ORIGIN_LABEL } from '../../components/owner/ConversationRow.jsx';

// PO-S4. Product feedback to the builder. Server-confirmed: the receipt appears only after the API answers.

const CATEGORY_CHOICES = FEEDBACK_CATEGORIES.map(([value]) => value);

/**
 * @param {{agentId: string, conversationId?: string|null, category?: string|null, topic?: string|null, signIn?: () => void}} props
 * `conversationId`, `category` and `topic` come from the query string (`?conversation=`, `?category=functionality`, `?topic=phone`).
 */
export default function Feedback({ agentId, conversationId = null, category = null, topic = null, signIn }) {
  const phone = topic === 'phone';
  const load = useLoad((signal) => withSessionCheck(() => ownerApi.listConversations(agentId, { limit: 100 }, signal), signal), [agentId]);
  const [receipt, setReceipt] = useState(/** @type {null|{feedbackId: string, receivedAt: string}} */ (null));
  const signedOut = load.error?.code === 'sign_in_required';
  const missing = load.status === 'error' && !signedOut && load.error?.status === 404;
  const listFailed = load.status === 'error' && !signedOut && !missing;
  usePageTitle('Feedback', load.status !== 'loading');

  const conversations = useMemo(() => {
    if (load.status !== 'ready') return null;
    const listed = (load.data?.conversations ?? []).map((item) => ({ conversationId: item.conversationId, label: `${ORIGIN_LABEL[item.origin] ?? 'Conversation'}, ${formatDateTime(item.startedAt)}` }));
    // A conversation named in the link stays selectable even when it is past the newest 100.
    if (conversationId && !listed.some((item) => item.conversationId === conversationId)) listed.unshift({ conversationId, label: 'Chosen conversation' });
    return listed;
  }, [load.status, load.data, conversationId]);

  return <Shell>
    <BackToBob agentId={agentId} />
    <h1>Feedback</h1>
    {load.status === 'loading' && <Loading>Loading feedback form…</Loading>}
    {signedOut && <Notice kind="warning" action={signIn && <Button onClick={signIn}>Sign in</Button>}>Sign in again to continue.</Notice>}
    {missing && <Notice kind="error" title="Couldn&apos;t find that receptionist." action={<AppLink className="bob-button bob-button--secondary" to="/app">Open receptionist</AppLink>} />}
    {listFailed && <Notice kind="error" title="Couldn't load conversations." action={<Button variant="secondary" onClick={load.reload}>Try again</Button>}>Feedback can still be sent without choosing one.</Notice>}
    {(load.status === 'ready' || listFailed) && !receipt && <>
      <p className="owner-lede">Tell the Frontline team how we can serve you better.</p>
      <FeedbackForm
        agentId={agentId}
        draftKey={`frontline.draft.feedback.${agentId}`}
        textLabel={phone ? 'What phone setup do you need?' : 'What should work better?'}
        initialCategory={phone ? 'functionality' : CATEGORY_CHOICES.includes(category ?? '') ? /** @type {string} */ (category) : ''}
        conversations={conversations}
        initialConversationId={conversationId ?? ''}
        onSent={({ receipt: sent }) => setReceipt(sent)}
        signIn={signIn}
      />
    </>}
    {receipt && <ReceiptCard receipt={receipt} action={<div className="owner-actions"><AppLink className="bob-button bob-button--secondary" to={`/app/agents/${agentId}`}>Back to receptionist</AppLink></div>}>
      Thanks. The Frontline team will read it.
    </ReceiptCard>}
  </Shell>;
}
