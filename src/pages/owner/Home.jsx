import { useEffect, useState } from 'react';
import { AppLink, navigate } from './router.jsx';
import AddReceptionistDialog, { LIMIT_MESSAGE } from '../../components/owner/AddReceptionistDialog.jsx';
import { needsKnowledgeReason } from '../../components/owner/BobFrame.jsx';
import { Button, EmptyState, Loading, Notice, Shell, SignInPrompt, StatusChip } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { errorMessage } from './error-copy.js';
import { ownerApi } from '../../lib/owner-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import { ownerFirstName } from '../../lib/owner-name.js';

// PO-S2. A greeting, then a Receptionist section (one card per claimed receptionist, then "Add receptionist") and a Feedback section.
// No analytics, no configuration, no phone activation.

export const RECEPTIONIST_LIMIT = 5;

/** The chip and sentence for one agent (design spec PO-DC1). "Active" means ready and taking calls. Paused wins over Needs knowledge. */
export function homeStatus(agent) {
  const name = receptionistName(agent);
  if (agent.status === 'deleting') return { chip: 'deleting', text: null, name: 'deleting' };
  if (agent.status === 'paused') return { chip: 'paused', text: null, name: 'paused' };
  if (agent.needsKnowledge) return { chip: 'needsKnowledge', text: needsKnowledgeReason(agent), name: 'needs knowledge' };
  if (agent.knowledgeState === 'unavailable' || agent.voiceAvailable === false) return { chip: 'attention', text: `${name} can't take calls right now.`, name: 'needs attention' };
  if (agent.knowledgeState === 'processing') return { chip: 'updating', text: null, name: 'updating' };
  if (agent.knowledgeState === 'untested_changes') return { chip: 'active', text: `${name} has new changes. Talk to ${name} to hear them before sharing.`, name: 'active' };
  return { chip: 'active', text: null, name: 'active' };
}

const DELETE_CHECK_MS = 3000;

/** The greeting line: the time of day and the owner's first name when sign-in supplied one. */
export const greeting = (firstName, now = new Date()) => {
  const hour = now.getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return firstName ? `Good ${part}, ${firstName}` : 'Welcome back';
};

/** @param {{agent: any, key?: string}} props */
function AgentEntryCard({ agent }) {
  const status = homeStatus(agent);
  const name = receptionistName(agent);
  const business = agent.businessName ?? 'your business';
  // A receptionist that is being deleted cannot be opened. Its card names it and goes away when the delete finishes.
  if (agent.status === 'deleting') {
    return <div className="owner-link-card owner-link-card--static owner-agent-entry" role="group" aria-label={`Deleting ${name}, ${business}.`}>
      <div className="owner-row">
        <div className="owner-agent-entry__body"><div><strong>{`Deleting ${name}`}</strong><span>{business}</span></div></div>
        <div className="owner-agent-entry__end"><StatusChip kind="deleting" /></div>
      </div>
    </div>;
  }
  return <AppLink className="owner-link-card owner-agent-entry" to={`/app/agents/${agent.stableAgentId}`} aria-label={`${name}, ${business}, ${status.name}. View.`}>
    <div className="owner-row">
      <div className="owner-agent-entry__body">
        <div>
          <strong>{name}</strong><span>{business}</span>
          {status.text && <p className="owner-muted">{status.text}</p>}
        </div>
      </div>
      <div className="owner-agent-entry__end">
        <StatusChip kind={status.chip} />
        <span className="owner-view" aria-hidden="true">View</span>
      </div>
    </div>
  </AppLink>;
}

/** MR-S1. The button under the cards. At the limit it is disabled and the reason stays visible. */
function AddReceptionist({ agents }) {
  const [open, setOpen] = useState(false);
  const full = agents.length >= RECEPTIONIST_LIMIT;
  return <div className="owner-add-receptionist">
    <Button variant="secondary" size="small" disabled={full} aria-haspopup="dialog" aria-describedby={full ? 'add-receptionist-reason' : undefined} onClick={() => setOpen(true)}>Add receptionist</Button>
    {full && <p id="add-receptionist-reason" className="owner-muted">{LIMIT_MESSAGE}</p>}
    {open && <AddReceptionistDialog takenNames={agents.map((agent) => receptionistName(agent))} onClose={() => setOpen(false)} onAdded={(added) => navigate(`/app/agents/${added.stableAgentId}`)} />}
  </div>;
}

/** A short invitation to tell the Frontline team how to serve the owner better. */
function FeedbackSection({ agentId }) {
  return <section className="owner-home__section" aria-labelledby="home-feedback">
    <h2 id="home-feedback">Feedback</h2>
    <div className="owner-card owner-card--feedback">
      <p>Tell the Frontline team how we can serve you better.</p>
      <AppLink className="bob-button bob-button--secondary bob-button--small" to={`/app/agents/${agentId}/feedback`}>Send feedback</AppLink>
    </div>
  </section>;
}

export default function Home({ signIn }) {
  const load = useLoad((signal) => ownerApi.listMyAgents(signal), []);
  const [firstName] = useState(() => ownerFirstName());
  const agents = load.data?.agents ?? [];
  const signedOut = load.error?.code === 'sign_in_required' || load.error?.status === 401;
  const heading = load.status === 'ready' && !agents.length ? 'No receptionist is saved to this account.' : greeting(firstName);
  usePageTitle('Home', load.status !== 'loading');
  const unfinished = agents.filter((agent) => agent.kind === 'workspace');
  const finished = agents.filter((agent) => agent.kind === 'agent');
  const feedbackTarget = finished.find((agent) => agent.status !== 'deleting');
  const anyDeleting = finished.some((agent) => agent.status === 'deleting');
  // A delete finishes in the background. Check again until the card is gone.
  useEffect(() => {
    if (!anyDeleting) return undefined;
    const timer = setInterval(load.reload, DELETE_CHECK_MS);
    return () => clearInterval(timer);
  }, [anyDeleting, load.reload]);
  return <Shell signedOut={signedOut}>
    {load.status === 'loading' && <><h1 className="owner-home__greeting">{greeting(firstName)}</h1><Loading>Loading your receptionist…</Loading></>}
    {signedOut && <SignInPrompt onSignIn={signIn} />}
    {load.status === 'error' && !signedOut && <><h1 className="owner-home__greeting">{greeting(firstName)}</h1><Notice kind="error" title="Couldn't load your receptionist." action={<Button variant="secondary" onClick={load.reload}>Try again</Button>}>{errorMessage(load.error)}</Notice></>}
    {load.status === 'ready' && agents.length === 0 && <>
      <h1>{heading}</h1>
      <EmptyState title="Set one up from the home page with your business website." action={<AppLink className="bob-button bob-button--primary" to="/">Set up a receptionist</AppLink>} />
    </>}
    {load.status === 'ready' && agents.length > 0 && finished.length === 0 && <>
      {/* PO-S2 "No agent yet": every saved thing is still an unfinished workspace. */}
      <h1>{`${receptionistName(unfinished[0])} needs your business details.`}</h1>
      {unfinished.map((workspace) => <section key={workspace.stableAgentId} className="owner-card">
        <p>{`Add them to get ${receptionistName(workspace)} ready.`}</p>
        <AppLink className="bob-button bob-button--primary" to={`/app/workspaces/${workspace.stableAgentId}/setup`}>Add business details</AppLink>
      </section>)}
    </>}
    {load.status === 'ready' && finished.length > 0 && <>
      <h1 className="owner-home__greeting">{heading}</h1>
      <section className="owner-home__section" aria-labelledby="home-receptionist">
        <h2 id="home-receptionist">Receptionist</h2>
        <div className="owner-agent-list">
          {finished.map((agent) => <AgentEntryCard key={agent.stableAgentId} agent={agent} />)}
        </div>
        <AddReceptionist agents={finished} />
        {unfinished.map((workspace) => <section key={workspace.stableAgentId} className="owner-card">
          <h3>{`${receptionistName(workspace)} needs your business details.`}</h3>
          <p>{`Add them to get ${receptionistName(workspace)} ready.`}</p>
          <AppLink className="bob-button bob-button--primary" to={`/app/workspaces/${workspace.stableAgentId}/setup`}>Add business details</AppLink>
        </section>)}
      </section>
      {feedbackTarget && <FeedbackSection agentId={feedbackTarget.stableAgentId} />}
    </>}
  </Shell>;
}
