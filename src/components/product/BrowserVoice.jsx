import { useEffect, useRef, useState } from 'react';
import { frontlineApi } from '../../lib/frontline-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import './browser-voice.css';

function mediaMessage(error) {
  if (['NotAllowedError', 'PermissionDeniedError'].includes(error?.name)) return 'Microphone access was blocked. Allow it in your browser settings, then try again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect one, then try again.';
  if (error?.name === 'NotReadableError') return 'Another app is using the microphone. Close it, then try again.';
  return "The microphone didn't start. Check it, then try again.";
}

function joinable(connection) {
  if (!connection?.demoId || !connection?.participantToken || !connection?.livekitUrl) return false;
  try {
    const url = new URL(connection.livekitUrl);
    return url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}

function timeLabel(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Transport for a server-authorized demo. The server owns deadlines and result persistence. */
export default function BrowserVoice({ connection, businessName, mode, onEnd, onBack = undefined, name = receptionistName() }) {
  const remoteSpeaking = `${name} is speaking`;
  const localSpeaking = 'Hearing you';
  const roomRef = useRef(null);
  const audioRef = useRef(null);
  const captionsRef = useRef(null);
  const followCaptionsRef = useRef(true);
  const generationRef = useRef(0);
  const finishedRef = useRef(false);
  const joinedRef = useRef(false);
  const phaseRef = useRef('ready');
  const reconnectReturnRef = useRef('connected');
  const captionSequenceRef = useRef(0);
  const [phase, setPhase] = useState('ready');
  const [error, setError] = useState('');
  const [microphoneOn, setMicrophoneOn] = useState(false);
  const [remoteAudio, setRemoteAudio] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [speaker, setSpeaker] = useState('');
  const [captions, setCaptions] = useState([]);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [connectSecondsLeft, setConnectSecondsLeft] = useState(null);
  const [hardEndAt, setHardEndAt] = useState(connection?.hardEndAt ?? null);
  const activeMode = mode || connection?.mode;
  const validConnection = joinable(connection);

  useEffect(() => {
    const panel = captionsRef.current;
    if (panel && followCaptionsRef.current) panel.scrollTop = panel.scrollHeight;
  }, [captions]);

  function changePhase(next) { phaseRef.current = next; setPhase(next); }
  function clearRoom(room) {
    if (roomRef.current === room) roomRef.current = null;
    room?.disconnect();
    audioRef.current?.replaceChildren();
  }
  async function finish(reason, preserveClosingAudio = false) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    generationRef.current += 1;
    const room = roomRef.current;
    changePhase('ending');
    let timer;
    const closeDeadline = new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('Conversation close timed out')), 50_000); });
    if (preserveClosingAudio && room) {
      let muteTimer;
      try {
        await Promise.race([
          room.localParticipant.setMicrophoneEnabled(false),
          new Promise((_, reject) => { muteTimer = window.setTimeout(() => reject(new Error('Microphone mute timed out')), 1_000); }),
        ]);
      } catch { clearRoom(room); }
      finally { window.clearTimeout(muteTimer); }
      setMicrophoneOn(false);
    } else {
      clearRoom(room);
    }
    try {
      await Promise.race([
        Promise.resolve(onEnd?.({ demoId: connection?.demoId, reason })),
        closeDeadline,
      ]);
      changePhase('ended');
    } catch {
      setError("The call ended, but the result didn't load. Try again.");
      changePhase('ended');
    } finally {
      window.clearTimeout(timer);
      clearRoom(room);
    }
  }

  useEffect(() => {
    const hardEndTime = Date.parse(hardEndAt || '');
    const tokenExpiresAt = Date.parse(connection?.tokenExpiresAt || '');
    const setupDeadlineAt = Date.parse(connection?.setupDeadlineAt || '');
    const update = () => {
      const now = Date.now();
      if (joinedRef.current && Number.isFinite(hardEndTime)) {
        const remaining = Math.max(0, Math.ceil((hardEndTime - now) / 1000));
        setSecondsLeft(remaining);
        if (remaining === 0) void finish('time_limit');
      } else if (!joinedRef.current && Number.isFinite(setupDeadlineAt)) {
        setConnectSecondsLeft(Math.max(0, Math.ceil((setupDeadlineAt - now) / 1000)));
      }
      if (!joinedRef.current && ['ready', 'connecting'].includes(phaseRef.current) &&
        ((Number.isFinite(tokenExpiresAt) && now >= tokenExpiresAt) ||
          (Number.isFinite(setupDeadlineAt) && now >= setupDeadlineAt))) {
        generationRef.current += 1;
        clearRoom(roomRef.current);
        changePhase('expired');
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
    // The deadline is server-owned and phase is held in a ref for this interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.demoId, connection?.tokenExpiresAt, connection?.setupDeadlineAt, hardEndAt]);

  useEffect(() => {
    if (!connection?.demoId || hardEndAt || !joinedRef.current || !['microphone', 'microphone_blocked', 'connected', 'reconnecting'].includes(phase)) return undefined;
    const controller = new AbortController();
    let timer;
    const refresh = async () => {
      try {
        const status = await frontlineApi.getDemo(connection.demoId, controller.signal);
        if (controller.signal.aborted) return;
        if (status?.reconnectAllowed === false || ['ending', 'ended', 'failed'].includes(status?.state)) { void finish(status?.terminalReason || 'server_ended', status?.state === 'ending'); return; }
        if (status?.hardEndAt) { setHardEndAt(status.hardEndAt); return; }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause?.status === 401 || cause?.status === 404) { void finish('session_expired'); return; }
      }
      timer = window.setTimeout(refresh, 1500);
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
    // The server owns the deadline; polling stops once it is returned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.demoId, hardEndAt, phase]);

  useEffect(() => () => {
    generationRef.current += 1;
    roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  async function checkReconnectStatus(attempt = generationRef.current) {
    changePhase('checking');
    setError('');
    try {
      const status = await frontlineApi.getDemo(connection.demoId);
      if (generationRef.current !== attempt || finishedRef.current) return false;
      if (status?.reconnectAllowed === false || ['ending', 'terminal', 'ended', 'failed'].includes(status?.state)) {
        void finish(status?.terminalReason || 'server_ended', status?.state === 'ending');
        return false;
      }
      if (status?.state !== 'active' || status?.reconnectAllowed !== true) throw new Error('Status unavailable');
      setError('Connection ended. Reconnect, or end the call to see the result.');
      changePhase('interrupted');
      return true;
    } catch {
      if (generationRef.current !== attempt || finishedRef.current) return false;
      setError("Couldn't tell if the call can continue. Check again or end the call.");
      changePhase('status_unknown');
      return false;
    }
  }

  async function connect() {
    if (!validConnection || !['ready', 'interrupted'].includes(phaseRef.current) || roomRef.current || finishedRef.current) return;
    if (joinedRef.current && !await checkReconnectStatus()) return;
    if (Date.parse(connection.tokenExpiresAt || '') <= Date.now() ||
      (!joinedRef.current && Date.parse(connection.setupDeadlineAt || '') <= Date.now() + 5_000)) {
      changePhase('expired');
      return;
    }
    const attempt = ++generationRef.current;
    setError('');
    setRemoteAudio(false);
    setMicrophoneOn(false);
    setAudioBlocked(false);
    setSpeaker('');
    changePhase('connecting');
    let room;
    const current = () => generationRef.current === attempt && roomRef.current === room;
    try {
      const { Room, RoomEvent, Track } = await import('livekit-client');
      if (generationRef.current !== attempt) return;
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
        setSpeaker(active ? active.isLocal ? localSpeaking : remoteSpeaking : 'Listening');
      });
      room.on(RoomEvent.Reconnecting, () => {
        if (!current()) return;
        reconnectReturnRef.current = phaseRef.current;
        changePhase('reconnecting');
      });
      room.on(RoomEvent.Reconnected, () => {
        if (current()) changePhase(reconnectReturnRef.current === 'microphone_blocked' ? 'microphone_blocked' : 'connected');
      });
      room.on(RoomEvent.Disconnected, () => {
        if (!current()) return;
        clearRoom(room);
        setRemoteAudio(false);
        setMicrophoneOn(false);
        setSpeaker('');
        if (joinedRef.current) {
          void checkReconnectStatus(attempt);
        } else {
          setError("Couldn't connect the call. Try again.");
          changePhase('ready');
        }
      });
      room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
        const text = await reader.readAll();
        if (!current() || reader.info?.attributes?.['lk.transcription_final'] !== 'true' || typeof text !== 'string' || !text.trim()) return;
        const segmentId = reader.info.attributes['lk.segment_id'] || `segment-${++captionSequenceRef.current}`;
        const key = `${participant.identity}:${segmentId}`;
        const who = participant.identity === room.localParticipant.identity ? 'You' : name;
        setCaptions((previous) => [...previous.filter((caption) => caption.key !== key), { key, who, text: text.trim() }].slice(-30));
      });
      await room.connect(connection.livekitUrl, connection.participantToken);
      if (!current()) { room.disconnect(); return; }
      joinedRef.current = true;
      changePhase('microphone');
      try { await room.startAudio(); }
      catch { if (current()) setAudioBlocked(true); }
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
      if (generationRef.current !== attempt) return;
      setError("Couldn't connect the call. Try again.");
      changePhase(joinedRef.current ? 'interrupted' : 'ready');
    }
  }

  useEffect(() => {
    if (!validConnection) return undefined;
    // Starting a demo is the visitor's connect action. Defer this until after
    // Strict Mode's development cleanup so it cannot launch twice on mount.
    const timer = window.setTimeout(() => { void connect(); }, 0);
    return () => window.clearTimeout(timer);
    // This effect belongs to the server-issued connection, not each render.
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
      setError('The browser blocked audio. Tap “Enable audio” again or check the sound settings.');
    }
  }

  const statusText = {
    ready: error ? `Couldn't connect to ${name}` : `Connecting to ${name}…`,
    connecting: `Connecting to ${name}…`,
    microphone: 'Connecting the microphone…',
    microphone_blocked: 'Connected. The microphone is off.',
    connected: microphoneOn ? (remoteAudio ? speaker || 'Listening' : `Microphone on. Waiting for ${name}’s audio…`) : 'Microphone muted',
    reconnecting: 'Connection interrupted. Reconnecting…',
    checking: 'Checking the call…',
    interrupted: 'Connection lost',
    status_unknown: 'Call status unavailable',
    ending: 'Ending the call…',
    ended: 'Call ended',
    expired: 'The connection timed out',
  }[phase];

  return <section className="browser-voice" aria-labelledby="browser-voice-title">
    <header className="browser-voice__intro">
      <p className="browser-voice__eyebrow">{activeMode === 'frontline_qa' ? 'Frontline' : businessName || 'Business'}</p>
      <h1 id="browser-voice-title">{`Call with ${name}`}</h1>
    </header>
    <div className="browser-voice__experience">
      <div className="browser-voice__panel">
        <div className="browser-voice__state" role="status" aria-live="polite"><span className={`browser-voice__light browser-voice__light--${phase}`} aria-hidden="true" /><span>{statusText}</span></div>
        {phase === 'connected' && <div className={`browser-voice__speaker ${speaker === remoteSpeaking ? 'browser-voice__speaker--bob' : speaker === localSpeaking ? 'browser-voice__speaker--caller' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /></div>}
        {secondsLeft !== null && phase !== 'ended' && <p className="browser-voice__time">{timeLabel(secondsLeft)} left</p>}
        {!joinedRef.current && connectSecondsLeft !== null && phase === 'ready' && error && <p className="browser-voice__time">Try again within {timeLabel(connectSecondsLeft)}</p>}
        {!validConnection && <p className="browser-voice__error" role="alert">{"Calling isn't available right now. Please contact the Frontline team."}</p>}
        {error && <p className="browser-voice__error" role="alert">{error}</p>}
        {audioBlocked && ['microphone', 'microphone_blocked', 'connected', 'reconnecting'].includes(phase) && <p className="browser-voice__audio-note">{`The browser is blocking ${name}’s audio. Turn on audio to hear the call.`}</p>}
        <div ref={audioRef} className="browser-voice__audio" aria-hidden="true" />
        <div className="browser-voice__actions">
          {phase === 'ready' && error && <button type="button" onClick={connect} disabled={!validConnection}>Try again</button>}
          {phase === 'status_unknown' && <button type="button" onClick={() => void checkReconnectStatus()}>Check again</button>}
          {phase === 'interrupted' && <button type="button" onClick={connect}>Reconnect</button>}
          {phase === 'connecting' && <button type="button" className="browser-voice__secondary" onClick={() => void finish('cancelled')}>Cancel</button>}
          {phase === 'microphone_blocked' && <button type="button" onClick={toggleMicrophone}>Try microphone again</button>}
          {audioBlocked && ['microphone_blocked', 'connected', 'reconnecting'].includes(phase) && <button type="button" className="browser-voice__secondary" onClick={enableSpeaker}>Enable audio</button>}
          {phase === 'connected' && <button type="button" className="browser-voice__secondary" onClick={toggleMicrophone}>{microphoneOn ? 'Mute' : 'Unmute'}</button>}
          {['microphone', 'microphone_blocked', 'connected', 'reconnecting', 'interrupted', 'checking', 'status_unknown'].includes(phase) && <button type="button" className="browser-voice__end" onClick={() => void finish('visitor_ended')}>End call</button>}
          {phase === 'expired' && joinedRef.current && <button type="button" onClick={() => void finish('token_expired')}>View call result</button>}
          {(phase === 'expired' || !validConnection) && onBack && <button type="button" className="browser-voice__secondary" onClick={onBack}>{`Meet ${name}`}</button>}
          {phase === 'ended' && onEnd && <button type="button" onClick={() => void onEnd({ demoId: connection?.demoId, reason: 'view_result' })}>View call result</button>}
        </div>
      </div>
      <section className="browser-voice__captions" aria-labelledby="browser-voice-captions">
        <div className="browser-voice__captions-heading"><h2 id="browser-voice-captions">Captions</h2><span>{speaker || 'Live captions'}</span></div>
        <div className="browser-voice__caption-scroll" ref={captionsRef} role="region" aria-label="Call captions. Scroll for earlier lines." tabIndex="0" onScroll={(event) => {
          const panel = event.currentTarget;
          followCaptionsRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 32;
        }}>
          {captions.length ? <ol aria-live="polite" aria-relevant="additions text">{captions.map((caption) => <li key={caption.key}><strong>{caption.who}</strong><p>{caption.text}</p></li>)}</ol> : <p className="browser-voice__empty">{"What's said on the call shows up here."}</p>}
        </div>
      </section>
    </div>
  </section>;
}
