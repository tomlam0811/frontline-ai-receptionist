import { Notice } from './ui.jsx';
import { receptionistName } from '../../lib/receptionist-name.js';
import './conversations.css';

// PO-DC17. The call as a conversation: back-to-back turns from the same speaker read as one message, and each
// message is labeled and styled by speaker. It never invents a turn: a missing Bob side or a capped transcript is
// said in words.

const noticeText = (name) => ({
  bob_side_not_recorded: `${name}'s side of this conversation wasn't recorded.`,
  partial: 'Part of this conversation is missing. Only what was recorded is shown.',
});

/** Consecutive turns from one speaker as one message. Speech recognition splits a caller's sentence into pieces. */
export function transcriptMessages(transcript) {
  const messages = [];
  for (const turn of transcript ?? []) {
    const text = `${turn.text ?? ''}${turn.interrupted ? ' (cut off)' : ''}`.trim();
    if (!text) continue;
    const last = messages.at(-1);
    if (last?.speaker === turn.speaker) last.text = `${last.text} ${text}`;
    else messages.push({ key: turn.seq, speaker: turn.speaker, text });
  }
  return messages;
}

/**
 * @param {{transcript: null|Array<{seq: number, speaker: 'caller'|'bob', text: string, interrupted?: boolean}>, notice: null|string, origin?: string, name?: string}} props
 */
export default function TranscriptView({ transcript, notice, origin, name = receptionistName() }) {
  const callerLabel = origin === 'shared' ? 'Guest' : 'Caller';
  const messages = transcriptMessages(transcript);
  return <section className="owner-transcript" aria-label="Transcript">
    <h2>Transcript</h2>
    {notice && noticeText(name)[notice] && <Notice>{noticeText(name)[notice]}</Notice>}
    {messages.length
      ? <ol className="owner-transcript__turns">
        {messages.map((message) => <li key={message.key} className={`owner-transcript__turn owner-transcript__turn--${message.speaker === 'bob' ? 'bob' : 'caller'}`}>
          <b>{message.speaker === 'bob' ? name : callerLabel}</b>
          <p>{message.text}</p>
        </li>)}
      </ol>
      : <p className="owner-muted">No transcript for this conversation.</p>}
  </section>;
}
