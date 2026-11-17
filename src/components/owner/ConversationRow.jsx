import { AppLink } from '../../pages/owner/router.jsx';
import { formatDateTime, formatDuration } from '../../pages/owner/format.js';
import './conversations.css';

// PO-DC16 (row). Origin, date and time, duration and status, as text. The whole row is one link.

export const ORIGIN_LABEL = { trial: 'Your call', owner_test: 'Your call', shared: 'Shared link' };

// A call that failed outright, or that ended through a real breakdown rather than a normal close, is
// "Interrupted". A call the caller or owner hung up on while a request was still unfinished is "Ended early".
// Everything else that finished is "Complete", including a call Bob closed himself after saving the request:
// that also ends as caller_ended, so the reason alone can't tell the two apart.
const INTERRUPTED_REASONS = new Set(['provider_failure', 'setup_timeout']);
const ENDED_EARLY_REASONS = new Set(['caller_ended']);

/** The status words the design allows (PO-DC16: "Complete"/"Ended early"/"Interrupted"). */
export function conversationStatus(state, terminalReason, requestLeftOpen) {
  if (state === 'failed' || INTERRUPTED_REASONS.has(terminalReason)) return { label: 'Interrupted', icon: '!', tone: 'warning' };
  if (state === 'ended' && ENDED_EARLY_REASONS.has(terminalReason) && requestLeftOpen !== false) return { label: 'Ended early', icon: '!', tone: 'warning' };
  if (state === 'ended') return { label: 'Complete', icon: '✓', tone: 'saved' };
  return { label: 'In progress', icon: '…', tone: 'processing' };
}

/** Whether the call used the receptionist as it is now or before later changes. Empty when that is not known. */
export function versionText(item, currentAgentVersionId) {
  if (!currentAgentVersionId || !item.agentVersionId) return '';
  return item.agentVersionId === currentAgentVersionId ? 'Used the latest changes' : 'Before later changes';
}

/** @param {{key?: string, agentId: string, item: any, ref?: import('react').Ref<HTMLAnchorElement>}} props */
export function ConversationRow({ agentId, item, ref }) {
  const status = conversationStatus(item.state, item.terminalReason, item.requestLeftOpen);
  const duration = formatDuration(item.durationSeconds);
  return <li>
    <AppLink ref={ref} className="owner-conversation" to={`/app/agents/${agentId}/conversations/${item.conversationId}`}>
      <strong>{ORIGIN_LABEL[item.origin] ?? 'Conversation'}</strong>
      <span className="owner-conversation__meta">
        <span>{formatDateTime(item.startedAt)}</span>
        {duration && <span>{duration}</span>}
        <span className={`owner-chip owner-chip--${status.tone}`}><span aria-hidden="true">{status.icon}</span> {status.label}</span>
      </span>
    </AppLink>
  </li>;
}
