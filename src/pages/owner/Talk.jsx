import { useEffect, useRef, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { AppLink } from './router.jsx';
import { Button, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { usePageTitle } from '../../components/owner/hooks.js';
import CallStage, { isEndedDemoState } from '../../components/owner/CallStage.jsx';
import { FocusHeading } from '../../components/owner/FocusHeading.jsx';
import { AccessGate, BackToBob, useBobSummary } from '../../components/owner/BobFrame.jsx';
import { fetchUntil } from '../../components/owner/await-terminal.js';
import CallSummary from '../../components/product/CallSummary.jsx';
import { errorMessage } from './error-copy.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import '../../components/owner/share-guest.css';

// PO-S5. The owner talks to the current version of Bob. "Talk to Bob" elsewhere in the app opens this screen with
// `startCall` in history state, so the call starts on arrival. Opening the address directly (a reload, a new tab)
// shows one Start call button instead, so a reload never starts a second call by itself.

const addDetailsText = (name) => `Add your business details to get ${name} ready.`;
const isSignedOut = (error) => error?.code === 'sign_in_required' || error?.status === 401;
const NOT_COUNTED = "This call didn't count toward today's limit.";
const pacificCalendarDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** What a failed start looks like on screen (design spec PO-S5 states). */
function startFailure(error, { reload, retry, signIn, name }) {
  if (isSignedOut(error)) return <Notice kind="error" title="Signed out. Sign in again to start the call." action={<Button variant="secondary" onClick={signIn}>Sign in</Button>} />;
  switch (error?.code) {
    case 'test_limit_reached': return <Notice kind="warning" title="You've used today's 3 test calls. The limit resets at midnight Pacific time." />;
    case 'voice_limit_reached': return <Notice kind="warning" title="Calls are paused right now. Please contact the Frontline team." />;
    case 'agent_busy': return <Notice kind="warning" title={`Another call with ${name} is in progress. Try again in a few minutes.`} action={<Button variant="secondary" onClick={retry}>Try again</Button>} />;
    case 'stale_agent_version': return <Notice kind="warning" title={`${name} was updated while this page was open. Reload to talk to the latest version.`} action={<Button variant="secondary" onClick={reload}>Reload</Button>} />;
    case 'agent_not_ready': return <Notice kind="warning" title={`${name} can't take a call yet.`}>{addDetailsText(name)}</Notice>;
    case 'connection_failed': return <Notice kind="error" title="Couldn't start the call." action={<Button variant="secondary" onClick={retry}>Try again</Button>}>{`Couldn't reach Frontline. Check your connection, then try again. ${NOT_COUNTED}`}</Notice>;
    case 'rate_limited': return <Notice kind="error" title="Couldn't start the call." action={<Button variant="secondary" onClick={retry}>Try again</Button>}>{errorMessage(error)}</Notice>;
    default: return <Notice kind="error" title="Couldn't start the call." action={<Button variant="secondary" onClick={retry}>Try again</Button>}>{NOT_COUNTED}</Notice>;
  }
}

/** Ended state: what came out of the call, and the way to talk again. */
function CallResult({ agentId, result, name, onTalkAgain }) {
  const heard = (result.callSummary?.callerTurnCount ?? 0) > 0;
  return <section className="owner-test-result" aria-labelledby="owner-call-ended">
    <FocusHeading id="owner-call-ended">Call ended</FocusHeading>
    {heard
      ? <CallSummary summary={result.callSummary} records={{ requests: result.requests, cases: result.cases }} showHeading={false} />
      : <Notice kind="warning" title={`${name} didn't hear anything on this call.`}>Check your microphone, then try again.</Notice>}
    <div className="owner-actions">
      <Button onClick={onTalkAgain}>Talk again</Button>
      <AppLink className="bob-button bob-button--secondary" to={`/app/agents/${agentId}/conversations`}>See all conversations</AppLink>
    </div>
    <p className="owner-links">
      <AppLink to={`/app/agents/${agentId}/feedback?conversation=${result.demoId}`}>Send feedback</AppLink>
    </p>
  </section>;
}

export default function Talk({ agentId, signIn }) {
  const bob = useBobSummary(agentId);
  const ok = bob.access === 'ok';
  const [stage, setStage] = useState({ name: 'idle' });
  const [startError, setStartError] = useState(null);
  const startedOnArrival = useRef(false);
  const data = bob.summary;
  const signedOut = bob.access === 'signedOut';
  const unfinished = bob.access === 'unfinished';
  // A foreign or nonexistent agent id gets the same "missing, with a way back to /app" state as the other
  // owner screens (BobFrame's AccessGate), instead of being read as an unfinished workspace.
  const missing = bob.access === 'missing';
  const name = receptionistName(bob.summary ?? bob.workspace);
  const startBlocked = ['test_limit_reached', 'voice_limit_reached'].includes(startError?.code);
  usePageTitle(`Talk to ${name}`, bob.status !== 'loading');

  async function start() {
    const requestedDay = pacificCalendarDay(new Date());
    setStage({ name: 'starting' }); setStartError(null);
    try {
      const connection = await ownerApi.startTest(agentId, data.currentAgentVersionId);
      setStage({ name: 'call', connection });
    } catch (error) {
      setStage({ name: 'idle' });
      setStartError(error?.code === 'test_limit_reached' && pacificCalendarDay(new Date()) !== requestedDay ? null : error);
    }
  }

  const notReadyReason = !data ? null : data.voiceAvailable === false ? "Calls aren't available right now. Please contact the Frontline team." : !data.ready ? addDetailsText(name) : null;

  useEffect(() => {
    if (startedOnArrival.current || !ok || !data || notReadyReason || !window.history.state?.startCall) return;
    startedOnArrival.current = true;
    window.history.replaceState({}, '', window.location.href);
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, data, notReadyReason]);

  useEffect(() => {
    if (startError?.code !== 'test_limit_reached') return undefined;
    const rejectedDay = pacificCalendarDay(new Date());
    const clearAfterPacificMidnight = () => {
      if (pacificCalendarDay(new Date()) !== rejectedDay) setStartError((current) => current?.code === 'test_limit_reached' ? null : current);
    };
    const timer = window.setInterval(clearAfterPacificMidnight, 30_000);
    window.addEventListener('focus', clearAfterPacificMidnight);
    document.addEventListener('visibilitychange', clearAfterPacificMidnight);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', clearAfterPacificMidnight);
      document.removeEventListener('visibilitychange', clearAfterPacificMidnight);
    };
  }, [startError]);

  const readStatus = (demoId) => async (signal) => {
    const result = await ownerApi.getTestResult(agentId, demoId, signal);
    return { ended: isEndedDemoState(result.state) || result.reconnectAllowed === false, closing: result.state === 'ending', reason: result.terminalReason ?? undefined, hardEndAt: result.hardEndAt, softCloseAt: result.softCloseAt };
  };

  async function endCall(demoId) {
    // The server may already have ended the call (time limit); ending again is not an error the owner can act on.
    try { await ownerApi.endTest(agentId, demoId); } catch (error) { if (isSignedOut(error)) throw error; }
    const result = await fetchUntil(() => ownerApi.getTestResult(agentId, demoId), (value) => ['ended', 'terminal', 'failed'].includes(value.state));
    setStage({ name: 'ended', result });
    bob.reload();
  }

  return <Shell>
    {!missing && <BackToBob agentId={agentId} name={name} />}
    {!missing && stage.name !== 'ended' && <h1>{`Talk to ${name}`}</h1>}
    {bob.status === 'loading' && <Loading>Loading your receptionist…</Loading>}
    {signedOut && <><p className="owner-lede">Sign in to talk to your receptionist.</p><Button onClick={signIn}>Sign in</Button></>}
    {bob.status === 'error' && <Notice kind="error" title="Couldn't load your receptionist." action={<Button variant="secondary" onClick={bob.reload}>Try again</Button>}>{errorMessage(bob.error)}</Notice>}
    {unfinished && <Notice kind="warning" title={`${name} can't take a call yet.`}>{addDetailsText(name)}</Notice>}
    {missing && <AccessGate bob={bob} signIn={signIn} />}
    {ok && data && (stage.name === 'idle' || stage.name === 'starting') && <>
      <p className="owner-lede">Talk the way a customer would. Calls last up to 5 minutes.</p>
      {notReadyReason
        ? <Notice kind="warning" title={`${name} can't take a call yet.`}>{notReadyReason}</Notice>
        : <>
          {startError && startFailure(startError, { name, reload: () => { setStartError(null); bob.reload(); }, retry: start, signIn })}
          {stage.name === 'starting'
            ? <Loading showLabel>{`Connecting to ${name}…`}</Loading>
            : !startBlocked && <div className="owner-actions"><Button onClick={start}>Start call</Button></div>}
        </>}
    </>}
    {stage.name === 'call' && <CallStage key={stage.connection.demoId} connection={stage.connection} label={`Call with ${name}`} name={name} getStatus={readStatus(stage.connection.demoId)} onEnd={() => endCall(stage.connection.demoId)} />}
    {stage.name === 'ended' && <CallResult name={name} agentId={agentId} result={stage.result} onTalkAgain={start} />}
  </Shell>;
}
