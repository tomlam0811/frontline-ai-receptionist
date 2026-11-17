# Frontline LiveKit voice worker

This worker is dispatched explicitly as `frontline-bob-demo`. It cannot create
a public demo by itself. The Frontline API must first authorize the anonymous
workspace, pin versions, reserve spend, create a one-room grant, and dispatch
metadata containing only `{ "demoId", "agentVersionId", "generation" }`.
The Node server-side adapter is `server/livekit-adapter.js` and uses the
installed `livekit-server-sdk` to create the room, explicitly dispatch this
worker, and mint a microphone-only participant token. The API calls
`start(demo, reservation)` only after its paid-start gate returns
`{ id, approved: true }`.

The worker then retrieves the immutable runtime bundle from the Frontline API
using its service identity, room name, generation and pinned agent version. It
does not accept facts, prompts or action grants from the browser or dispatch
metadata. Business mode gets scoped lookup and simulated intake tools;
Frontline Q&A gets a separate read-only product lookup. A simulated request is
private, pending confirmation, unbooked and unsent.

## Configuration

Install `requirements.txt` in an isolated Python environment. Configure:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: LiveKit project
  connection for the Agents runtime.
- `FRONTLINE_API_BASE_URL`: HTTPS URL for the Frontline API (local loopback HTTP
  is accepted for development).
- `FRONTLINE_VOICE_SERVICE_TOKEN`: scoped service credential. Do not put it in
  source, dispatch metadata or browser responses.
- `OPENAI_API_KEY`, falling back to the existing `MODEL_API_KEY`: credential for
  the pinned direct OpenAI plugins. The worker fixes STT to
  `gpt-live-transcribe` and Responses LLM to `gpt-4.1-mini`. Bob speaks with
  Cartesia Sonic-3 voice Blake through LiveKit Inference, which uses the
  LiveKit credentials and inference credits. If Cartesia fails, TTS falls back
  to `gpt-4o-mini-tts` with the `cedar` voice by default. The worker accepts
  `FRONTLINE_TTS_VOICE` from the supported OpenAI voice set for that fallback. Bob's approved
  delivery direction asks for a friendly, slightly deeper voice at a
  conversational pace that varies with meaning. Digit groups get their
  pauses from the spoken phone form in `speech.py`, not from a voice
  instruction to slow down. `evaluate_tts_pacing.py` measures the effect.
- `FRONTLINE_VOICE_AGENT_NAME`: optional named dispatch target; defaults to
  `frontline-bob-demo` in both the Node adapter and Python worker.

From this directory run `python agent.py dev` for a connected development
worker, or `python agent.py start` for production worker startup. Do not enable
paid public starts until the API has a configured spend ceiling and concurrent
session cap.

## Runtime API

The worker calls the runtime/readiness routes and the frozen `contracts/v1`
turn, retrieval, request, lookup, case, escalation, ending, and terminal
routes. Every call includes the service bearer
credential plus `X-Frontline-Room`, `X-Frontline-Generation` and
`X-Frontline-Agent-Version-Id`. The API must verify the exact demo, room,
generation, owner and version binding on every request. The `ready` response
provides server-owned `softCloseAt` and `hardEndAt`; recovery reuses them.

The worker begins its close at the server's 270-second deadline. The API and
adapter watchdog independently enforce the 300-second hard end, including
after worker loss. Transcript projection, reconnection and provider-level
interruption checks still require an integrated session.

The adapter exposes `scheduleHardEnd(demo)` for process-local deletion and
`startWatchdog()` for a durable DB-backed sweep. The API must inject
`listDueDemos(now)` and `onHardEnd(demo)` callbacks, start the watchdog, and
monitor `watchdogHealthy()` before each paid start. The adapter itself rejects
starts while this check is false. The process-local timer alone is insufficient across
restarts. `isReady(demo)` checks that the named visitor has an unmuted
microphone publication and an agent participant has joined. The worker calls
`POST .../ready` only after fetching the bundle and starting its session, so
the API can stamp the readiness barrier when both conditions hold.
The adapter returns `tokenExpiresAt` separately from the anonymous workspace's
24-hour `expiresAt`; the room-scoped browser join token lasts at most seven
minutes and is issued only after a successful spend reservation.

Evidence today: Python syntax validation; installed `livekit-agents` 1.8.3 in
the ignored local `.venv`; imported the worker and constructed both mode
agents without provider calls; imported `livekit-server-sdk` 2.19.1 and
checked the Node adapter API shape. Live audio still needs a scoped LiveKit
project, a configured cost limit, and real browser-path verification.


## Finalized-turn and response boundary

Every finalized provider item ID maps to a deterministic UUID scoped to the demo.
Duplicate final events do not start another turn. One serialized `/turn` stream
uses a single workflow revision shared with Bob's tools. Speech runs outside that
lock. Each speech handle is bound to a turn epoch, so an interrupted generation
cannot invoke tools granted to a newer turn or record a stale readback.

Ordinary mutations serialize in independently owned tasks. Cancelling a LiveKit
tool waiter does not release its pending operation's lock or change its payload.
A caller turn can still preempt an unresolved save: server CAS decides whether
that save committed first or was fenced by ending. A late original receipt is
retained without restoring old permissions, lowering the current revision, or
speaking a stale continuation. Only a `stale_workflow` conflict carrying explicit
positive `currentWorkflowRevision` permits one retry of the exact same caller
turn. Mutations are never blindly retried with revised payloads.

All frozen endpoint requests and responses use `contracts/v1` schema validation.
Responses require the flat `requestId`/`version` envelope and strip exactly those
keys before payload validation. Turn tools, workflow state, evidence eligibility,
knowledge revisions, receipt operation IDs/kinds and confirmation/readback
bindings also receive semantic checks. Runtime/readiness/product-fact endpoints
predate the freeze and have explicit local shape and binding validation. Runtime
bundles must supply authoritative `workflowRevision` and `stateRevision` for
reconnect recovery. Missing or malformed authority fails closed.

Timed demo closes state that the time is up. They never imply that a save failed
when no save was attempted. Escalation claims a record only after a validated
saved receipt. An unresolved save uses “couldn't confirm” wording. Closing audio
respects the server closing deadline and remaining hard deadline. Local session
close failure cannot prevent the room disconnect attempt.

Verification: `python -m unittest discover -s workers/voice -p test_voice.py`
exercises real Bob tool adapters and orchestration against deterministic fake
runtime/LiveKit handles, including human interruption during blocked readback
and pending saving, cancelled tool waiters, same-turn conflict reconciliation,
response rejection, and truthful timed close. This is local regression evidence,
not verification of provider audio, a deployed worker, or a live browser journey.


## Exact request readback and recovered sessions

A complete `validate_request` tool result suppresses LiveKit's model follow-up
with `ToolResult(reply_required=False)`. After that tool's speech handle finishes,
the orchestrator passes every field in the validated snapshot, including optional
fields and time zone, directly to `AgentSession.say`, in short parts
(`speech.plan_readback`): on the first pass contact details, the remaining fields, then
the confirmation question. Phone numbers are spoken in groups of digits and emails
with "at" and "dot"; the stored values do not change. Each part that plays without
interruption marks its values as heard. After a correction only the changed values
are read, followed by "Anything else to change, or is that good?". The matching
field revision/hash is recorded only after the closing question played uninterrupted
and every current value has been heard with nothing changed since. The next affirmative
caller turn can confirm that recorded snapshot without an extra intake turn.
Explicit server readback actions use this same exact speech path. Corrections,
negations, and new field turns invalidate local validation/readback context until
a fresh validation returns. Human escalation can interrupt the exact readback.
Closing text and the initial greeting also use `say`, without model rewriting.

The runtime bundle explicitly carries `sessionState`, `currentValidation`, and
`currentReadback`. Snapshots are validated against the existing frozen schemas,
canonical field hashes, revision limits, matching fields/workflow IDs, and demo
mode. Only server `active` state permits recovery after the setup window, and a
fresh `/ready` response must preserve the original started/soft/hard deadlines.
Expired or terminal sessions cannot reopen. No shared contract schema is changed
by the worker.

The fixed-speech character count measures text passed to TTS. The existing
model-generated speech counter still measures instruction length and is not an
actual generated-audio cost meter; a validated provider spend upper bound remains
an integration gate.
