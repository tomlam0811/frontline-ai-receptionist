import { useEffect, useRef, useState } from 'react';
import { guestApi } from '../../lib/owner-api.js';
import { Button, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { usePageTitle } from '../../components/owner/hooks.js';
import CallStage, { isEndedDemoState } from '../../components/owner/CallStage.jsx';
import MicCheck from '../../components/owner/MicCheck.jsx';
import GuestResult from '../../components/owner/GuestResult.jsx';
import { FocusHeading } from '../../components/owner/FocusHeading.jsx';
import { fetchUntil } from '../../components/owner/await-terminal.js';
import { forgetGuestToken, takeGuestToken } from '../../components/owner/guest-token.js';
import '../../components/owner/share-guest.css';

// PO-S7. The guest page for a shared link. The link's secret arrives in the URL fragment, is removed from the
// address bar at once, and is held in memory only. No sign-in prompt, no owner navigation, no analytics: this page
// reads only what /v1/shared/* returns, which is this one conversation and the business name.

const LIMITS_TEXT = 'Talk the way you would on the phone. Conversations last up to 5 minutes.';
const disclosureText = (business) => `${business} can read a summary and transcript of this conversation. The Frontline team may read any feedback you send. Conversations are deleted after 30 days.`;
const ASK_FOR_NEW = 'Ask the person who sent you the link for a new one.';
const STARTED_MARKER = 'frontline.guest.started';

// Dead ends. Each one has a heading and one sentence, and nothing else to do.
const DEAD_ENDS = {
  unavailable: ["This link isn't available.", ASK_FOR_NEW],
  used: ['This conversation has ended.', `Each link works for one conversation. ${ASK_FOR_NEW}`],
  expired: ['This link has expired.', ASK_FOR_NEW],
  revoked: ['This link is no longer active.', ASK_FOR_NEW],
  busy: ['Someone else has started this conversation.', `Each link works for one conversation. ${ASK_FOR_NEW}`],
  lost: ["This conversation can't be reopened from this browser.", ASK_FOR_NEW],
};

const deadEndFor = (error) => {
  const reason = error?.body?.reason;
  if (error?.code === 'link_busy') return 'busy';
  if (error?.code === 'link_used') return 'used';
  return ['used', 'expired', 'revoked'].includes(reason) ? reason : 'unavailable';
};

const rememberStarted = () => { try { window.sessionStorage.setItem(STARTED_MARKER, '1'); } catch { /* the page works without it */ } };
const wasStarted = () => { try { return window.sessionStorage.getItem(STARTED_MARKER) === '1'; } catch { return false; } };

const sessionEnded = (session) => session.linkStatus === 'consumed' || isEndedDemoState(session.demo?.state);

export default function Guest() {
  const [view, setView] = useState({ name: 'checking' });
  const [micReady, setMicReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [startFailure, setStartFailure] = useState(null);
  const [starting, setStarting] = useState(false);
  // The receptionist's name and business, from whichever link response arrived last.
  const [facts, setFacts] = useState(null);
  const opened = useRef(false);
  const name = facts?.receptionistName ?? 'the receptionist';
  const business = facts?.businessName ?? 'The business';
  const heading = `Talk to ${name}`;
  usePageTitle(heading, view.name !== 'checking');

  async function showResult() {
    const result = await fetchUntil(() => guestApi.result(), (value) => value.linkStatus === 'consumed' || isEndedDemoState(value.state));
    setView({ name: 'ended', result });
  }

  async function open() {
    setView({ name: 'checking' });
    try {
      const token = takeGuestToken();
      if (token) {
        // The token stays in memory while the entry page is open. If the guest's preview stops working, one more
        // exchange tells which dead end it is.
        const link = await guestApi.exchange(token);
        setFacts(link);
        setView({ name: 'entry' });
        return;
      }
      const session = await guestApi.session();
      if (session.link) setFacts(session.link);
      if (session.linkStatus === 'unused') { setView({ name: 'entry' }); return; }
      if (sessionEnded(session)) { await showResult(); return; }
      if (!session.demo || session.demo.state === 'dispatching') { setView({ name: 'stuck' }); return; }
      try {
        const connection = await guestApi.reconnect();
        setView({ name: 'call', connection, returning: true });
      } catch (error) {
        if (error?.code === 'session_ended') await showResult();
        else if (error?.code === 'voice_unavailable') setView({ name: 'stuck' });
        else throw error;
      }
    } catch (error) {
      if (error?.code === 'connection_failed') { setView({ name: 'offline' }); return; }
      forgetGuestToken();
      if (error?.code === 'link_unavailable') { setView({ name: 'dead', kind: deadEndFor(error) }); return; }
      // No token and no working session: the cookie is gone. Say so only if this tab did start a conversation.
      if (error?.code === 'guest_session_required' || error?.status === 401) { setView({ name: 'dead', kind: wasStarted() ? 'lost' : 'unavailable' }); return; }
      setView({ name: 'offline' });
    }
  }

  useEffect(() => {
    // One open per page load; React's development double effect must not exchange the link twice.
    if (opened.current) return;
    opened.current = true;
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The preview stopped working between the entry page and the start button. Ask the server why. */
  async function whyStartRefused() {
    const token = takeGuestToken();
    if (!token) return 'unavailable';
    try { await guestApi.exchange(token); return 'unavailable'; } catch (error) {
      const kind = deadEndFor(error);
      // "Unavailable" for a link that was valid a moment ago means another browser started it.
      return kind === 'unavailable' ? 'busy' : kind;
    }
  }

  async function start() {
    setStarting(true); setStartFailure(null);
    try {
      const connection = await guestApi.start();
      forgetGuestToken();
      rememberStarted();
      setView({ name: 'call', connection, returning: false });
    } catch (error) {
      if (['link_busy', 'link_used', 'link_unavailable'].includes(error?.code)) { forgetGuestToken(); setView({ name: 'dead', kind: deadEndFor(error) }); return; }
      if (error?.code === 'guest_session_required') { const kind = await whyStartRefused(); forgetGuestToken(); setView({ name: 'dead', kind }); return; }
      if (error?.code === 'connection_failed') { setStartFailure({ released: true, network: true }); return; }
      // The server says whether the link went back to unused. Only then may the guest try again.
      const session = await guestApi.session().catch(() => null);
      setStartFailure({ released: session?.linkStatus === 'unused', atCapacity: error?.code === 'voice_limit_reached' });
    } finally { setStarting(false); }
  }

  const readStatus = async (signal) => {
    const session = await guestApi.session(signal);
    const state = session.demo?.state;
    return { ended: sessionEnded(session), closing: state === 'ending' && session.linkStatus !== 'consumed', reason: session.demo?.terminalReason ?? undefined, hardEndAt: session.demo?.hardEndAt, softCloseAt: session.demo?.softCloseAt };
  };

  async function endCall() {
    try {
      await guestApi.end();
    } catch (error) {
      if (error?.status === 401) { setView({ name: 'dead', kind: 'revoked' }); return; }
    }
    try { await showResult(); } catch (error) {
      if (error?.status === 401) { setView({ name: 'dead', kind: 'revoked' }); return; }
      throw error;
    }
  }

  return <Shell guest>
    {view.name === 'checking' && <><h1>{heading}</h1><Loading>Checking this link…</Loading></>}
    {view.name === 'offline' && <><h1>{heading}</h1><Notice kind="error" title="Couldn't reach Frontline." action={<Button variant="secondary" onClick={() => void open()}>Try again</Button>}>Check your connection, then try again.</Notice></>}
    {view.name === 'dead' && <><FocusHeading as="h1">{DEAD_ENDS[view.kind][0]}</FocusHeading><p className="owner-lede">{DEAD_ENDS[view.kind][1]}</p></>}
    {view.name === 'stuck' && <><FocusHeading as="h1">This link can&apos;t start right now.</FocusHeading><p className="owner-lede">Reload this page in a few minutes. If it still doesn&apos;t start, ask the person who sent you the link.</p></>}
    {view.name === 'entry' && <>
      <h1>{heading}</h1>
      <p className="owner-lede">{facts?.businessName ? `${facts.receptionistName} is the receptionist for ${facts.businessName}.` : `${facts?.receptionistName} is an AI receptionist.`}</p>
      <p>{LIMITS_TEXT}</p>
      <p className="owner-muted">{disclosureText(business)}</p>
      <MicCheck onReadyChange={setMicReady} disabled={starting} name={facts?.receptionistName} />
      {startFailure && <Notice kind="error" title={startFailure.network ? "Couldn't reach Frontline." : startFailure.atCapacity ? `${facts?.receptionistName ?? 'The receptionist'} is busy right now.` : "Couldn't start the call."} action={startFailure.released ? <Button variant="secondary" onClick={start}>Try again</Button> : undefined}>
        {startFailure.network ? 'Check your connection, then try again.' : startFailure.atCapacity ? "This link hasn't been used yet. Try again in a few minutes." : startFailure.released ? 'Try again. If it keeps failing, ask the person who sent you the link.' : 'Ask the person who sent you the link for help.'}
      </Notice>}
      {starting && <Loading showLabel>{`Connecting to ${name}…`}</Loading>}
      <div className="owner-actions">
        <Button busy={starting} disabled={!micReady} onClick={start}>{starting ? 'Starting…' : 'Start conversation'}</Button>
        <Button variant="secondary" disabled={starting} onClick={() => setDismissed(true)}>Not now</Button>
      </div>
      {dismissed && <p className="owner-muted" role="status">Not started. This link hasn&apos;t been used yet.</p>}
    </>}
    {view.name === 'call' && <>
      <h1>{heading}</h1>
      {view.returning && <p className="owner-muted">Back in your conversation.</p>}
      <CallStage key={view.connection.demoId} connection={view.connection} label={`Conversation with ${name}`} name={name} getStatus={readStatus} onEnd={endCall} refreshConnection={() => guestApi.reconnect()} />
    </>}
    {view.name === 'ended' && <GuestResult result={view.result} name={name} businessName={facts?.businessName ?? null} />}
  </Shell>;
}
