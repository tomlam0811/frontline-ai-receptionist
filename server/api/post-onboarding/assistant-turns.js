import { problem } from './errors.js';
import { withOwnerState } from './owner-state.js';
import { TRANSCRIPT_ENTRY_CAP } from './conversations.js';

// Bob's spoken text, recorded by the voice worker (technical spec PO-E17, PO-TD13). This is a
// display record only: no workflow decision reads it. Each turn is stored once per clientTurnId.

export const ASSISTANT_TURN_MAX_CHARS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function appendAssistantTurn({ db, scopeId, demoId, body, now = new Date() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  if (typeof body.clientTurnId !== 'string' || !UUID.test(body.clientTurnId)) throw problem(400, 'invalid_field', 'clientTurnId: send a UUID.');
  if (typeof body.text !== 'string' || !body.text.trim()) throw problem(400, 'invalid_field', 'text: send the spoken text.');
  if (body.text.length > ASSISTANT_TURN_MAX_CHARS) throw problem(413, 'input_too_large', `text: use up to ${ASSISTANT_TURN_MAX_CHARS} characters.`);
  if (typeof body.interrupted !== 'boolean') throw problem(400, 'invalid_field', 'interrupted: send true or false.');
  return withOwnerState(db, scopeId, (state) => {
    const demo = state.demos?.[demoId];
    if (!demo) throw problem(404, 'not_found', 'Not found.');
    if (!Number.isInteger(body.expectedStateRevision) || body.expectedStateRevision !== (demo.stateRevision ?? 1)) throw problem(409, 'session_ending', 'This session no longer accepts changes.');
    const turns = state.transcripts?.[demoId] ?? [];
    const replay = turns.find((turn) => turn.turnId === body.clientTurnId);
    if (replay) return { result: { seq: replay.seq, replayed: true } };
    // 'ending' stays open: the worker speaks its goodbye after the ending transition bumps stateRevision,
    // so a call's last words would otherwise never be recorded. Once terminal, no further speech follows.
    if (!['active', 'waiting', 'ending'].includes(demo.state)) throw problem(409, 'session_ending', 'This session no longer accepts changes.');
    if (turns.length >= TRANSCRIPT_ENTRY_CAP) throw problem(409, 'transcript_full', 'This conversation reached the recorded-turn limit.');
    const entry = { seq: turns.length + 1, speaker: 'bob', text: body.text.trim(), at: now.toISOString(), turnId: body.clientTurnId, ...(body.interrupted ? { interrupted: true } : {}) };
    return { result: { seq: entry.seq, replayed: false }, state: { ...state, transcripts: { ...state.transcripts, [demoId]: [...turns, entry] } } };
  });
}
