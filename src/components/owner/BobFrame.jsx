import { ownerApi } from '../../lib/owner-api.js';
import { AppLink } from '../../pages/owner/router.jsx';
import { useLoad } from './hooks.js';
import { BackButton, Button, Notice, SignInPrompt, StatusChip } from './ui.jsx';
import { useEffect, useRef } from 'react';
import { receptionistName } from '../../lib/receptionist-name.js';

// Pieces shared by the Bob detail screen and its Knowledge and Capabilities sections (design spec PO-S9, PO-DC3, PO-DC4).
// Other section screens can reuse `BackToBob` and `useBobSummary`.

/**
 * Loads the agent summary the Bob screens need. When the agent cannot be read the reason is worked out
 * so each screen shows the right state: signed out, an unfinished workspace, or nothing saved under that id.
 * `access` is 'ok' | 'signedOut' | 'unfinished' | 'missing'.
 * @param {string} agentId
 */
export function useBobSummary(agentId) {
  const load = useLoad(async (signal) => {
    try {
      return { access: 'ok', summary: await ownerApi.getSummary(agentId, signal), workspace: null };
    } catch (error) {
      if (error?.name === 'AbortError' || ![401, 404].includes(error?.status)) throw error;
      try {
        const { agents } = await ownerApi.listMyAgents(signal);
        const match = agents.find((agent) => agent.stableAgentId === agentId) ?? null;
        return { access: match?.kind === 'workspace' ? 'unfinished' : 'missing', summary: null, workspace: match };
      } catch (inner) {
        if (inner?.name === 'AbortError') throw inner;
        if (inner?.status === 401 || inner?.code === 'sign_in_required') return { access: 'signedOut', summary: null, workspace: null };
        throw error;
      }
    }
  }, [agentId]);
  return { ...load, access: load.data?.access ?? null, summary: load.data?.summary ?? null, workspace: load.data?.workspace ?? null };
}

/** Icon back control to the receptionist page, at the top of a section screen. @param {{agentId: string, name?: string}} props */
export function BackToBob({ agentId, name = receptionistName() }) {
  return <BackButton to={`/app/agents/${agentId}`} label={`Back to ${name}`} />;
}

/**
 * Identity card: the receptionist's name and the business name, with the primary action below and an optional
 * menu (`menu`) in the top right corner.
 * @param {{summary: any, heading?: boolean, menu?: any, children?: any}} props
 */
export function BobIdentity({ summary, heading = true, menu = null, children = null }) {
  const business = summary.businessName ?? 'your business';
  const name = receptionistName(summary);
  return <section className="owner-card owner-identity" aria-label={name}>
    <div className="owner-identity__top">
      <div className="owner-identity__body">
        {heading ? <h1>{name}</h1> : <p className="owner-identity__name">{name}</p>}
        <p className="owner-identity__business">{business}</p>
        {summary.status === 'paused'
          ? <p className="owner-chips"><StatusChip kind="paused" /></p>
          : summary.needsKnowledge && <p className="owner-chips"><StatusChip kind="needsKnowledge" /></p>}
      </div>
      {menu}
    </div>
    {children}
  </section>;
}

/** MR-D10. The sentence for a receptionist with no selected source, or null when it has one. Paused is shown first where both apply. */
export function needsKnowledgeReason(summary) {
  return summary?.needsKnowledge ? `${receptionistName(summary)} needs knowledge before it can take calls. Choose at least one source.` : null;
}

/** Why Talk and Share are unavailable, or null when they work. */
export function callBlocker(summary) {
  if (!summary) return 'Finish your business details first.';
  if (summary.status === 'paused') return `${receptionistName(summary)} is paused.`;
  if (summary.needsKnowledge) return needsKnowledgeReason(summary);
  if (!summary.ready) return `${receptionistName(summary)} isn't ready yet.`;
  if (summary.voiceAvailable === false) return "Calls aren't available right now. Please contact the Frontline team.";
  return null;
}

/**
 * What to show when the agent cannot be opened. Returns null when access is fine, so a screen can `return gate ?? content`.
 * @param {any} props
 */
export function AccessGate({ bob, signIn, children }) {
  if (bob.status === 'loading') return null;
  if (bob.status === 'error') {
    return <><h1>Receptionist</h1><Notice kind="error" title="Couldn't load your receptionist." action={<Button variant="secondary" onClick={bob.reload}>Try again</Button>}>{"Couldn't reach Frontline. Check your connection, then try again."}</Notice></>;
  }
  if (bob.access === 'signedOut') return <SignInPrompt onSignIn={signIn} />;
  if (bob.access === 'unfinished') {
    const name = receptionistName(bob.workspace);
    return <>
      <h1>{`${name} isn't ready yet.`}</h1>
      <AppLink className="bob-button bob-button--primary" to={`/app/workspaces/${bob.workspace.stableAgentId}/setup`}>Add business details</AppLink>
      <p className="owner-muted">{children ?? 'Finish your business details first.'}</p>
    </>;
  }
  if (bob.access === 'missing') return <><h1>{"Couldn't find that receptionist."}</h1><AppLink className="bob-button bob-button--primary" to="/app">Open receptionist</AppLink></>;
  return null;
}

/** PO-CP5. Focus moves here so a keyboard user is not left on a removed section. */
export function AppliedBanner({ agentId, name = receptionistName() }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="owner-applied" role="status" aria-label="Changes saved">
    <h2 ref={heading} tabIndex={-1}>{`Changes saved. Talk to ${name} to hear them.`}</h2>
    <div className="owner-actions"><AppLink className="bob-button bob-button--primary" to={`/app/agents/${agentId}/talk`} state={{ startCall: true }}>{`Talk to ${name}`}</AppLink></div>
  </section>;
}

/** PO-CP6. Draft changes are kept; the owner chooses to review them again after the newer change or discard them. */
export function ConflictNotice({ onReview, onDiscard, busy = false, name = receptionistName() }) {
  return <section className="owner-notice owner-notice--warning owner-conflict" role="alert">
    <span className="owner-notice__icon" aria-hidden="true">!</span>
    <div>
      <h2>{`${name} was updated while you worked.`}</h2>
      <p>Someone saved a change, maybe you in another tab. Review your changes again.</p>
      <div className="owner-actions">
        <Button onClick={onReview} busy={busy}>Review changes again</Button>
        <Button variant="secondary" onClick={onDiscard} busy={busy}>Discard changes</Button>
      </div>
    </div>
  </section>;
}
