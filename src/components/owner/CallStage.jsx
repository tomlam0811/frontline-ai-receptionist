import { useEffect, useRef, useState } from 'react';
import { clock } from '../../pages/owner/format.js';
import './call-stage.css';

// The live-voice surface for the owner test and the shared guest call (design spec PO-DS5, PO-S5, PO-S7).
// It is the transport and the on-screen states only. It owns no endpoint: the page passes the room
// credentials the server issued and three callbacks, so one component serves both call kinds.
//
// Connection item: the existing BrowserVoice (src/components/product/BrowserVoice.jsx) is tied to
// frontlineApi.getDemo. At connection it can be reduced to a thin wrapper over this component.
//
//   connection         { demoId, livekitUrl, participantToken, tokenExpiresAt, setupDeadlineAt }
//   label              visible name of the surface, for example "Call with Bob"
//   name               what the receptionist is called on screen; "the receptionist" when the page has no name
//   getStatus(signal)  -> { ended: boolean, closing?: boolean, reason?: string, hardEndAt?: string|null, softCloseAt?: string|null }
//                      `closing` means Bob is speaking the goodbye, so the room stays open until it ends.
//                      The server owns the deadline and the end. An error with status 401 or 404 ends the call.
//   onEnd(reason)      ends the call on the server and resolves when the result can be shown
//   refreshConnection  optional. Returns fresh credentials for the same room (guest reconnect).
//   pollMs             how often the server state is read

const ENDED_STATES = ['ending', 'terminal', 'ended', 'failed'];
// The longest the goodbye is kept playing before the call is ended from here.
const CLOSING_WAIT_MS = 12_000;

function mediaMessage(error) {
  if (['NotAllowedError', 'PermissionDeniedError'].includes(error?.name)) return 'The browser blocked the microphone. Allow it in the address bar or browser settings, then try again.';
  if (error?.name === 'NotFoundError') return 'No microphone found. Connect one, then try again.';
  if (error?.name === 'NotReadableError') return 'Another app is using the microphone. Close that app, then try again.';
  return "Couldn't start the microphone. Check the device, then try again.";
}

/** Only a secure room address is joined; plain ws is allowed for a local room. */
function joinable(connection) {
  if (!connection?.demoId || !connection?.participantToken || !connection?.livekitUrl) return false;
  try {
    const url = new URL(connection.livekitUrl);
    return url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}

const statusText = (name) => ({
  connecting: `Connecting to ${name}…`,
  retry: `Couldn't connect to ${name}`,
  microphone: 'Connecting the microphone…',
  microphone_blocked: 'Connected. The microphone is off.',
  reconnecting: 'Connection interrupted. Reconnecting…',
  checking: 'Checking the conversation…',
  interrupted: 'Connection lost',
  ending: 'Ending the conversation…',
  ended: 'Conversation ended',
  expired: 'Connecting took too long',
});

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** @param {{connection: any, label: string, getStatus: (signal: AbortSignal) => Promise<any>, onEnd: (reason: string) => Promise<any>, refreshConnection?: () => Promise<any>, pollMs?: number, name?: string}} props */
/** @param {{connection: any, label: string, getStatus: (signal?: AbortSignal) => Promise<any>, onEnd: (reason?: string) => Promise<any>, refreshConnection?: () => Promise<any>, pollMs?: number, name?: string, key?: string}} props */
export default function CallStage({ connection, label, getStatus, onEnd, refreshConnection, pollMs = 1500, name = 'the receptionist' }) {
  const roomRef = useRef(null);
  const audioRef = useRef(null);
  const attemptRef = useRef(0);
  const pollStoppedRef = useRef(false);
  const finishedRef = useRef(false);
  const joinedRef = useRef(false);
  const phaseRef = useRef('connecting');
  const returnPhaseRef = useRef('connected');
  const captionCountRef = useRef(0);
  const credentialsRef = useRef(connection);
  const callbacks = useRef({ getStatus, onEnd, refreshConnection });
  callbacks.current = { getStatus, onEnd, refreshConnection };

  const [phase, setPhase] = useState('connecting');
  const [error, setError] = useState('');
  const [microphoneOn, setMicrophoneOn] = useState(false);
  const [remoteAudio, setRemoteAudio] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [speaker, setSpeaker] = useState('');
  const [captions, setCaptions] = useState([]);
  const [hardEndAt, setHardEndAt] = useState(null);
  const [softCloseAt, setSoftCloseAt] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [wrappingUp, setWrappingUp] = useState(false);
  const validConnection = joinable(connection);

  function changePhase(next) { phaseRef.current = next; setPhase(next); }
  function clearRoom(room) {
    if (roomRef.current === room) roomRef.current = null;
    room?.disconnect();
    audioRef.current?.replaceChildren();
  }

  async function closingFinished() {
    const deadline = Date.now() + CLOSING_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => { window.setTimeout(resolve, Math.min(pollMs, 500)); });
      try {
        const status = await callbacks.current.getStatus(new AbortController().signal);
        if (!status?.closing) return;
      } catch { return; }
    }
  }

  async function finish(reason, keepClosingAudio = false) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    pollStoppedRef.current = true;
    attemptRef.current += 1;
    const room = roomRef.current;
    changePhase('ending');
    if (keepClosingAudio && room) {
      // Bob is speaking the close. Mute the caller, keep the room so the goodbye is heard.
      let muteTimer;
      try {
        await Promise.race([room.localParticipant.setMicrophoneEnabled(false), new Promise((_, reject) => { muteTimer = window.setTimeout(() => reject(new Error('mute timed out')), 1000); })]);
      } catch { clearRoom(room); } finally { window.clearTimeout(muteTimer); }
      setMicrophoneOn(false);
      // onEnd ends the call on the server, which closes the room. Wait for the server to report the call ended after
      // the goodbye (the worker's close budget is 9s), so the goodbye is not cut off a moment after it starts.
      await closingFinished();
    } else clearRoom(room);
    let timer;
    try {
      await Promise.race([Promise.resolve(callbacks.current.onEnd(reason)), new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('close timed out')), 50_000); })]);
      changePhase('ended');
    } catch {
      // Allow one more try from the "Show result" button.
      finishedRef.current = false;
      setError("The conversation ended. Couldn't load the result. Try again.");
      changePhase('ended');
    } finally { window.clearTimeout(timer); clearRoom(room); }
  }

  // Server state: the deadline, the soft close and any end that happened elsewhere (time limit, owner revoked the link).
  useEffect(() => {
    if (!connection?.demoId) return undefined;
    const controller = new AbortController();
    let timer;
    const read = async () => {
      try {
        const status = await callbacks.current.getStatus(controller.signal);
        if (controller.signal.aborted || pollStoppedRef.current) return;
        if (status?.hardEndAt) setHardEndAt(status.hardEndAt);
        if (status?.softCloseAt) setSoftCloseAt(status.softCloseAt);
        if (status?.ended) { void finish(status.reason || 'server_ended', Boolean(status.closing)); return; }
      } catch (cause) {
        if (controller.signal.aborted || pollStoppedRef.current) return;
        if (cause?.status === 401 || cause?.status === 404) { void finish('session_expired'); return; }
      }
      timer = window.setTimeout(read, pollMs);
    };
    void read();
    return () => { controller.abort(); window.clearTimeout(timer); };
    // The status reader is read through a ref; the poll belongs to the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.demoId, pollMs]);

  // Visible time is the server deadline, never a client timer of our own.
  useEffect(() => {
    const hardEnd = Date.parse(hardEndAt || '');
    const softClose = Date.parse(softCloseAt || '');
    const tokenExpiresAt = Date.parse(connection?.tokenExpiresAt || '');
    const setupDeadlineAt = Date.parse(connection?.setupDeadlineAt || '');
    const update = () => {
      const now = Date.now();
      if (joinedRef.current && Number.isFinite(hardEnd)) {
        const remaining = Math.max(0, Math.ceil((hardEnd - now) / 1000));
        setSecondsLeft(remaining);
        if (remaining === 0) void finish('time_limit');
      }
      setWrappingUp(Number.isFinite(softClose) && now >= softClose);
      if (!joinedRef.current && ['connecting', 'retry'].includes(phaseRef.current) && ((Number.isFinite(tokenExpiresAt) && now >= tokenExpiresAt) || (Number.isFinite(setupDeadlineAt) && now >= setupDeadlineAt))) {
        attemptRef.current += 1;
        clearRoom(roomRef.current);
        changePhase('expired');
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardEndAt, softCloseAt, connection?.tokenExpiresAt, connection?.setupDeadlineAt]);

  useEffect(() => () => {
    attemptRef.current += 1;
    roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  async function checkBeforeReconnect(attempt) {
    changePhase('checking');
    setError('');
    try {
      const status = await callbacks.current.getStatus(new AbortController().signal);
      if (attemptRef.current !== attempt || finishedRef.current) return false;
      if (status?.ended) { void finish(status.reason || 'server_ended', Boolean(status.closing)); return false; }
      return true;
    } catch (cause) {
      if (attemptRef.current !== attempt || finishedRef.current) return false;
      if (cause?.status === 401 || cause?.status === 404) { void finish('session_expired'); return false; }
      setError("Couldn't check whether this conversation can continue. Reconnect to try again, or end the call.");
      changePhase('interrupted');
      return false;
    }
  }

  async function connect() {
    if (!['connecting', 'retry', 'interrupted'].includes(phaseRef.current) || roomRef.current || finishedRef.current) return;
    const attempt = ++attemptRef.current;
    if (joinedRef.current) {
      if (!await checkBeforeReconnect(attempt)) return;
      if (callbacks.current.refreshConnection) {
        try { credentialsRef.current = { ...credentialsRef.current, ...await callbacks.current.refreshConnection() }; } catch (cause) {
          if (attemptRef.current !== attempt || finishedRef.current) return;
          if (cause?.status === 401 || cause?.status === 404 || cause?.status === 409) { void finish('session_expired'); return; }
          setError("Couldn't rejoin the conversation. Reconnect to try again, or end the call.");
          changePhase('interrupted');
          return;
        }
      }
    }
    const credentials = credentialsRef.current;
    if (Date.parse(credentials.tokenExpiresAt || '') <= Date.now()) { changePhase('expired'); return; }
    if (!joinedRef.current && Date.parse(credentials.setupDeadlineAt || '') <= Date.now() + 5000) { changePhase('expired'); return; }
    setError('');
    setRemoteAudio(false);
    setMicrophoneOn(false);
    setAudioBlocked(false);
    setSpeaker('');
    changePhase('connecting');
    let room;
    const current = () => attemptRef.current === attempt && roomRef.current === room;
    try {
      const { Room, RoomEvent, Track } = await import('livekit-client');
      if (attemptRef.current !== attempt) return;
      room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (!current() || track.kind !== Track.Kind.Audio || !audioRef.current) return;
        const element = track.attach();
        element.autoplay = true;
        audioRef.current.appendChild(element);
        setRemoteAudio(true);
        if (!room.canPlayAudio) setAudioBlocked(true);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (!current() || track.kind !== Track.Kind.Audio) return;
        for (const element of track.detach()) element.remove();
        setRemoteAudio(audioRef.current?.childElementCount > 0);
      });
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (current()) setAudioBlocked(!room.canPlayAudio); });
      room.on(RoomEvent.ActiveSpeakersChanged, (participants) => {
        if (!current()) return;
        const active = participants[0];
        setSpeaker(active ? (active.isLocal ? 'Hearing you' : `${capitalize(name)} is speaking`) : 'Listening');
      });
      room.on(RoomEvent.Reconnecting, () => {
        if (!current()) return;
        returnPhaseRef.current = phaseRef.current;
        changePhase('reconnecting');
      });
      room.on(RoomEvent.Reconnected, () => { if (current()) changePhase(returnPhaseRef.current === 'microphone_blocked' ? 'microphone_blocked' : 'connected'); });
      room.on(RoomEvent.Disconnected, () => {
        if (!current()) return;
        clearRoom(room);
        setRemoteAudio(false);
        setMicrophoneOn(false);
        setSpeaker('');
        if (joinedRef.current) void checkBeforeReconnect(attempt).then((canRejoin) => { if (canRejoin && attemptRef.current === attempt) { setError('The connection dropped. Reconnect, or end the call.'); changePhase('interrupted'); } });
        else { setError("Couldn't connect the call. Check your connection, then try again."); changePhase('retry'); }
      });
      room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
        const text = await reader.readAll();
        if (!current() || reader.info?.attributes?.['lk.transcription_final'] !== 'true' || typeof text !== 'string' || !text.trim()) return;
        const segment = reader.info.attributes['lk.segment_id'] || `segment-${++captionCountRef.current}`;
        const key = `${participant.identity}:${segment}`;
        const who = participant.identity === room.localParticipant.identity ? 'You' : 'Support';
        setCaptions((previous) => [...previous.filter((caption) => caption.key !== key), { key, who, text: text.trim() }].slice(-30));
      });
      await room.connect(credentials.livekitUrl, credentials.participantToken);
      if (!current()) { room.disconnect(); return; }
      joinedRef.current = true;
      changePhase('microphone');
      try { await room.startAudio(); } catch { if (current()) setAudioBlocked(true); }
      if (!current()) return;
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        if (!current()) return;
        setMicrophoneOn(true);
        changePhase('connected');
      } catch (cause) {
        if (!current()) return;
        setError(mediaMessage(cause));
        changePhase('microphone_blocked');
      }
    } catch {
      if (room) clearRoom(room);
      if (attemptRef.current !== attempt) return;
      setError("Couldn't connect the call. Check your connection, then try again.");
      changePhase(joinedRef.current ? 'interrupted' : 'retry');
    }
  }

  useEffect(() => {
    if (!validConnection) return undefined;
    // Starting the call was the person's action. Defer past Strict Mode's development cleanup so it cannot join twice.
    const timer = window.setTimeout(() => { void connect(); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.demoId, validConnection]);

  async function toggleMicrophone() {
    const room = roomRef.current;
    if (!room || !['microphone_blocked', 'connected'].includes(phaseRef.current)) return;
    setError('');
    try {
      const enable = !microphoneOn;
      await room.localParticipant.setMicrophoneEnabled(enable);
      if (roomRef.current !== room) return;
      setMicrophoneOn(enable);
      changePhase('connected');
    } catch (cause) {
      setError(mediaMessage(cause));
      changePhase('microphone_blocked');
    }
  }

  async function enableSpeaker() {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
      if (roomRef.current === room) setAudioBlocked(!room.canPlayAudio);
    } catch {
      setAudioBlocked(true);
      setError('The browser blocked audio. Select "Enable audio" again, or check the browser\'s sound settings.');
    }
  }

  const statusLabels = statusText(name);
  const statusLine = phase === 'connected'
    ? (microphoneOn ? (remoteAudio ? speaker || 'Listening' : `Microphone on. Waiting for ${name}…`) : 'Microphone muted')
    : phase === 'retry' && !error ? statusLabels.connecting : statusLabels[phase];
  const live = ['microphone', 'microphone_blocked', 'connected', 'reconnecting'].includes(phase);

  return <section className="owner-call" aria-label={label}>
    <p className="owner-call__label">{label}</p>
    <div className="owner-call__panel">
      <div className="owner-call__state" role="status" aria-live="polite"><span className={`owner-call__light owner-call__light--${phase}`} aria-hidden="true" /><span>{statusLine}</span></div>
      {secondsLeft !== null && !['ended', 'ending'].includes(phase) && <p className="owner-call__time">{clock(secondsLeft)} remaining</p>}
      {wrappingUp && live && <p className="owner-call__time">{capitalize(name)} is wrapping up.</p>}
      {!validConnection && <p className="owner-call__error" role="alert">The call isn&apos;t available. Go back and try again.</p>}
      {error && <p className="owner-call__error" role="alert">{error}</p>}
      {audioBlocked && live && <p className="owner-call__note">{`The browser is blocking ${name}'s audio. Select Enable audio to hear the conversation.`}</p>}
      <div ref={audioRef} className="owner-call__audio" aria-hidden="true" />
      <div className="owner-call__actions">
        {phase === 'retry' && error && <button type="button" onClick={connect} disabled={!validConnection}>Try again</button>}
        {phase === 'interrupted' && <button type="button" onClick={connect}>Reconnect</button>}
        {phase === 'connecting' && <button type="button" className="owner-call__secondary" onClick={() => void finish('cancelled')}>Cancel</button>}
        {phase === 'microphone_blocked' && <button type="button" onClick={toggleMicrophone}>Try microphone again</button>}
        {audioBlocked && live && <button type="button" className="owner-call__secondary" onClick={enableSpeaker}>Enable audio</button>}
        {phase === 'connected' && <button type="button" className="owner-call__secondary" onClick={toggleMicrophone}>{microphoneOn ? 'Mute' : 'Unmute'}</button>}
        {['microphone', 'microphone_blocked', 'connected', 'reconnecting', 'interrupted', 'checking'].includes(phase) && <button type="button" className="owner-call__end" onClick={() => void finish('visitor_ended')}>End call</button>}
        {phase === 'expired' && <button type="button" onClick={() => void finish('setup_expired')}>Close</button>}
        {phase === 'ended' && error && <button type="button" onClick={() => void finish('view_result')}>Show result</button>}
      </div>
    </div>
    <section className="owner-call__captions" aria-labelledby="owner-call-captions">
      <div className="owner-call__captions-heading"><h2 id="owner-call-captions">Captions</h2><span>From this live session</span></div>
      {captions.length ? <ol aria-live="polite">{captions.map((caption) => <li key={caption.key}><strong>{caption.who}</strong><p>{caption.text}</p></li>)}</ol> : <p className="owner-call__empty">What&apos;s said on the call shows up here.</p>}
    </section>
  </section>;
}

/** True for the demo states that mean the call is over or being closed by the server. */
export const isEndedDemoState = (state) => ENDED_STATES.includes(state);
