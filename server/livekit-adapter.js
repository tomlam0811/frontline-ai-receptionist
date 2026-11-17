import { AccessToken, LiveKitAPI, RoomAgentDispatch, RoomConfiguration, TrackSource } from 'livekit-server-sdk';

const DEFAULT_AGENT_NAME = 'frontline-bob-demo';
const AGENT_KIND = 4; // livekit.ParticipantInfo.Kind.AGENT in @livekit/protocol.
const MAX_JOIN_TOKEN_SECONDS = 7 * 60;
// From Railway us-west2 on 2026-10-03 each LiveKit server API request took about 3.2 seconds, so a room
// delete needs more than the 2 seconds that was enough from Europe.
const ROOM_DELETE_TIMEOUT_MS = 8_000;

function requireOpaque(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function asDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}`);
  return date;
}

function restHost(livekitUrl) {
  const url = new URL(livekitUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname)) url.protocol = 'http:';
  else throw new Error('LIVEKIT_URL must use WSS, or local loopback WS');
  return url.origin;
}

function isMissingRoom(error) {
  return error?.status === 404 || error?.code === 404 || error?.code === 'not_found';
}

/**
 * LiveKit transport for an API-authorized, cost-reserved Frontline demo.
 *
 * API ownership and budget checks belong outside this adapter. A reservation
 * must have an ID and approved=true before any LiveKit API call is made.
 * Inject `listDueDemos` + `onHardEndDue` + `onHardEnd` from durable storage and call
 * `startWatchdog()` in the API process for restart-safe hard-end recovery.
 */
export function createLiveKitAdapter(options = {}) {
  const livekitUrl = options.livekitUrl ?? process.env.LIVEKIT_URL;
  const apiKey = options.apiKey ?? process.env.LIVEKIT_API_KEY;
  const apiSecret = options.apiSecret ?? process.env.LIVEKIT_API_SECRET;
  const deployment = options.deployment ?? process.env.FRONTLINE_VOICE_AGENT_DEPLOYMENT;
  const agentName = requireOpaque(
    (options.agentName ?? process.env.FRONTLINE_VOICE_AGENT_NAME ?? '').trim() || DEFAULT_AGENT_NAME,
    'voice agent name',
  );
  const listDueDemos = options.listDueDemos;
  const onHardEndDue = options.onHardEndDue;
  const onHardEnd = options.onHardEnd;
  const configured = Boolean(livekitUrl && apiKey && apiSecret);
  const timers = new Map();
  const pendingDeletes = new Map();
  let api;
  let sweepTimer;
  let watchdogIntervalMs = 3_000;
  let lastSweepSucceededAt = 0;

  function requireApi() {
    if (!configured) throw new Error('voice_unavailable');
    if (!api) api = options.api ?? new LiveKitAPI({ host: restHost(livekitUrl), apiKey, secret: apiSecret });
    return api;
  }

  async function end(demo) {
    const roomName = requireOpaque(demo.roomName, 'room name');
    const key = requireOpaque(demo.id, 'demo ID');
    const client = requireApi();
    let deletion = pendingDeletes.get(roomName);
    if (!deletion) {
      deletion = client.room.deleteRoom(roomName).catch((error) => {
        if (!isMissingRoom(error)) throw error;
      }).finally(() => pendingDeletes.delete(roomName));
      pendingDeletes.set(roomName, deletion);
    }
    let timeout;
    try {
      await Promise.race([
        deletion,
        new Promise((_, rejectTimeout) => { timeout = setTimeout(() => rejectTimeout(new Error('voice_room_delete_timeout')), ROOM_DELETE_TIMEOUT_MS); timeout.unref?.(); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  async function enforceHardEnd(demo) {
    const hardEndAt = asDate(demo.hardEndAt, 'hard deadline');
    if (hardEndAt.getTime() > Date.now()) return false;
    if (onHardEndDue) await onHardEndDue(demo);
    await end(demo);
    if (onHardEnd) await onHardEnd(demo);
    return true;
  }

  function scheduleHardEnd(demo) {
    requireApi();
    const id = requireOpaque(demo.id, 'demo ID');
    const deadline = asDate(demo.hardEndAt, 'hard deadline');
    const remaining = deadline.getTime() - Date.now();
    if (remaining > 5 * 60 * 1000 + 30 * 1000) throw new Error('Hard deadline exceeds demo policy');
    const prior = timers.get(id);
    if (prior) clearTimeout(prior);
    const attempt = () => {
      enforceHardEnd(demo).catch(() => {
        // Retry locally as well as in the durable sweep; no content is logged.
        const retry = setTimeout(attempt, 3_000);
        retry.unref?.();
        timers.set(id, retry);
      });
    };
    const timer = setTimeout(attempt, Math.max(0, remaining));
    timer.unref?.();
    timers.set(id, timer);
  }

  async function sweepDueHardEnds() {
    if (typeof listDueDemos !== 'function' || typeof onHardEndDue !== 'function' || typeof onHardEnd !== 'function') {
      throw new Error('Durable hard-end callbacks are required');
    }
    try {
      let failed = 0;
      for (const demo of await listDueDemos(new Date())) {
        try { await enforceHardEnd(demo); }
        catch { failed += 1; }
      }
      if (failed) throw new Error(`${failed} LiveKit room deadline deletions failed`);
      lastSweepSucceededAt = Date.now();
    } catch (error) {
      lastSweepSucceededAt = 0;
      throw error;
    }
  }

  function watchdogHealthy() {
    return Boolean(
      configured && sweepTimer && lastSweepSucceededAt &&
      Date.now() - lastSweepSucceededAt <= Math.max(10_000, watchdogIntervalMs * 2),
    );
  }

  function startWatchdog({ intervalMs = 3_000 } = {}) {
    requireApi();
    if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 30_000) {
      throw new Error('Invalid watchdog interval');
    }
    if (sweepTimer) return () => stopWatchdog();
    if (typeof listDueDemos !== 'function' || typeof onHardEndDue !== 'function' || typeof onHardEnd !== 'function') {
      throw new Error('Durable hard-end callbacks are required');
    }
    watchdogIntervalMs = intervalMs;
    sweepTimer = setInterval(() => {
      sweepDueHardEnds().catch(() => {
        // The next sweep retries. The host must monitor watchdog health.
      });
    }, intervalMs);
    sweepTimer.unref?.();
    void sweepDueHardEnds().catch(() => {});
    return () => stopWatchdog();
  }

  function stopWatchdog() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
    lastSweepSucceededAt = 0;
  }

  /**
   * The browser's room token: it may join one room and publish only its microphone. A start token also carries the
   * room settings and the named worker, so LiveKit creates the room and dispatches Blake when the caller joins.
   */
  async function signParticipantToken(participantIdentity, roomName, roomConfig) {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      ttl: MAX_JOIN_TOKEN_SECONDS,
      name: 'Visitor',
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      roomRecord: false,
    });
    if (roomConfig) token.roomConfig = roomConfig;
    return token.toJwt();
  }

  /**
   * A fresh join token for the room a demo already has, for a guest or owner who reconnects. It makes no
   * provider call and starts no room or worker. The caller decides whether the demo may still be joined.
   */
  async function issueParticipantToken(demo) {
    if (!configured) throw new Error('voice_unavailable');
    const roomName = requireOpaque(demo.roomName, 'room name');
    const demoId = requireOpaque(demo.id, 'demo ID');
    const participantToken = await signParticipantToken(`visitor-${demoId}`, roomName);
    return { livekitUrl, participantToken, tokenExpiresAt: new Date(Date.now() + (MAX_JOIN_TOKEN_SECONDS - 5) * 1_000).toISOString() };
  }

  // Calls start with token dispatch (docs.livekit.io/agents/server/agent-dispatch, "Dispatch via access token").
  // Starting through the server API took about seven sequential requests, and from Railway us-west2 each took about
  // 3.2 seconds on 2026-10-03, so every start ran past its deadline. Token dispatch needs no request: LiveKit applies
  // it only when the first participant creates the room, and every demo has its own new room name. A reconnect
  // token carries no room settings, so it can never dispatch a second worker.
  async function start(demo, reservation) {
    if (!reservation || reservation.approved !== true || !requireOpaque(reservation.id, 'paid-start reservation')) {
      throw new Error('paid_start_not_reserved');
    }
    if (!watchdogHealthy()) throw new Error('voice_watchdog_unavailable');
    requireApi();
    const demoId = requireOpaque(demo.id, 'demo ID');
    // Frontline Q&A pins a platform product revision rather than a business
    // agent. The API's internal binding uses this same sentinel version.
    const agentVersionId = requireOpaque(demo.agentVersionId ?? 'frontline-qa-v1', 'agent version ID');
    const roomName = requireOpaque(demo.roomName, 'room name');
    const generation = demo.generation;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid worker generation');
    const participantIdentity = `visitor-${demoId}`;
    const roomConfig = new RoomConfiguration({
      emptyTimeout: 60,
      departureTimeout: 15,
      maxParticipants: 2,
      agents: [new RoomAgentDispatch({
        agentName,
        metadata: JSON.stringify({ demoId, agentVersionId, generation }),
        ...(deployment ? { deployment } : {}),
      })],
    });
    const participantToken = await signParticipantToken(participantIdentity, roomName, roomConfig);
    return {
      livekitUrl,
      participantToken,
      tokenExpiresAt: new Date(Date.now() + (MAX_JOIN_TOKEN_SECONDS - 5) * 1_000).toISOString(),
      roomName,
      participantIdentity,
      dispatchId: null,
    };
  }

  /** One request: the caller is in the room with an unmuted microphone and exactly one agent has joined. */
  async function isReady(demo) {
    const client = requireApi();
    const roomName = requireOpaque(demo.roomName, 'room name');
    const demoId = requireOpaque(demo.id, 'demo ID');
    const participants = await client.room.listParticipants(roomName);
    const caller = participants.find((participant) => participant.identity === (demo.participantIdentity || `visitor-${demoId}`));
    const agents = participants.filter((participant) => participant.kind === AGENT_KIND);
    return Boolean(caller && agents.length === 1 && caller.tracks?.some((track) => track.source === TrackSource.MICROPHONE && !track.muted));
  }

  return {
    isConfigured: () => configured,
    start,
    issueParticipantToken,
    isReady,
    watchdogHealthy,
    end,
    enforceHardEnd,
    scheduleHardEnd,
    sweepDueHardEnds,
    startWatchdog,
    stopWatchdog,
  };
}
