import { ownerApi } from '../../lib/owner-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import { AppLink } from './router.jsx';
import { Button, EmptyState, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { errorMessage } from './error-copy.js';
import Knowledge from './Knowledge.jsx';

// The business Knowledge library (/app/knowledge), opened from the top bar: every source with its facts and the receptionists
// that use it. Changes are made through one receptionist (`agentId` from the address, else the first), which is the one that
// reviews and applies them. Choosing which sources a receptionist uses is on its own Knowledge page (ReceptionistKnowledge).

const SHARED_LEDE = 'What every receptionist can use.';

/** Loading, signed-out, error and empty states. Shown only when there is no receptionist to open. */
function NoKnowledge({ load, signIn }) {
  const signedOut = load.error?.code === 'sign_in_required' || load.error?.status === 401;
  const unfinished = (load.data?.agents ?? []).find((agent) => agent.kind === 'workspace');
  usePageTitle('Knowledge', load.status !== 'loading');
  return <Shell signedOut={signedOut}>
    {load.status === 'loading' && <><h1>Knowledge</h1><Loading>Loading Knowledge…</Loading></>}
    {signedOut && <><h1>Sign in to see Knowledge.</h1><Button onClick={signIn}>Sign in</Button></>}
    {load.status === 'error' && !signedOut && <><h1>Knowledge</h1><Notice kind="error" title="Couldn't load Knowledge." action={<Button variant="secondary" onClick={load.reload}>Try again</Button>}>{errorMessage(load.error)}</Notice></>}
    {load.status === 'ready' && unfinished && <>
      <h1>Knowledge</h1>
      <EmptyState title={`Knowledge opens once ${receptionistName(unfinished)} is ready.`} action={<AppLink className="bob-button bob-button--primary" to={`/app/workspaces/${unfinished.stableAgentId}/setup`}>Add business details</AppLink>}>Add the business details first.</EmptyState>
    </>}
    {load.status === 'ready' && !unfinished && <>
      <h1>Knowledge</h1>
      <EmptyState title="No receptionist yet." action={<AppLink className="bob-button bob-button--primary" to="/">Set up a receptionist</AppLink>}>Knowledge appears here once a receptionist is saved to this account.</EmptyState>
    </>}
  </Shell>;
}

/** @param {{signIn?: () => void, category?: string, notice?: string|null, agentId?: string|null}} props */
export default function BusinessKnowledge({ signIn, category, notice, agentId = null }) {
  const load = useLoad((signal) => ownerApi.listMyAgents(signal), []);
  const receptionists = (load.data?.agents ?? []).filter((agent) => agent.kind === 'agent' && agent.status !== 'deleting');
  const receptionist = receptionists.find((agent) => agent.stableAgentId === agentId) ?? receptionists[0];
  if (load.status === 'ready' && receptionist) return <Knowledge agentId={receptionist.stableAgentId} category={category} notice={notice} signIn={signIn} basePath="/app/knowledge" lede={receptionists.length > 1 ? SHARED_LEDE : `Everything ${receptionistName(receptionist)} can use.`} />;
  return <NoKnowledge load={load} signIn={signIn} />;
}
