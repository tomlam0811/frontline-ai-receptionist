import './call-summary.css';
import ReviewNote, { recordNotes, unrecordedTasks } from './ReviewNote.jsx';

/**
 * The call result. Every request the receptionist could not finish is a Needs review note, status only (VA-D4).
 * `records` ({requests, cases}) are notes to show here. `listedSeparately` are records the page shows elsewhere:
 * a task one of them stands for is left out so the same request never appears twice.
 * `audience="caller"` is the shared-link guest's own view: what they asked for and who has it, with no owner
 * review status, missing details, next step or caller notes.
 */
export default function CallSummary({ summary, records = null, listedSeparately = null, showHeading = true, omitRecordedTasks = false, showEmptyState = true, audience = 'owner', businessName = null }) {
  if (!summary) return null;
  if (audience === 'caller') {
    const asked = unrecordedTasks(summary.tasks, []);
    if (!asked.length) return null;
    return <section className="outcome-list" aria-label="Call result">
      {asked.map((item, index) => <ReviewNote key={`${item.kind}-${index}`} item={item} variant="outcome" audience="caller" businessName={businessName} />)}
    </section>;
  }
  const allTasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  const shown = recordNotes(records);
  const tasks = unrecordedTasks(allTasks, [...shown, ...recordNotes(listedSeparately)], { omitRecorded: omitRecordedTasks });
  const notes = [...shown, ...tasks];
  const excerpts = Array.isArray(summary.callerExcerpts) ? summary.callerExcerpts : [];
  // Everything from this call is shown elsewhere on the page.
  if (!notes.length && !excerpts.length && (allTasks.length || !showEmptyState)) return null;
  return <section className="outcome-list" aria-label="Call result">
    {showHeading && <div className="bob-intro"><p className="bob-eyebrow">Call result</p><h2>{notes.length ? 'What was discussed' : summary.mode === 'frontline_qa' ? 'Frontline questions' : 'Conversation'}</h2>{!notes.length && excerpts.length > 0 && <p>Open Caller notes to see a few lines from the call.</p>}</div>}
    {notes.map((item, index) => <ReviewNote key={item.recordId ?? `${item.kind}-${index}`} item={item} variant="outcome" />)}
    {excerpts.length > 0 && <details className="outcome-card call-summary__notes"><summary>Caller notes</summary><p>A few lines from the call:</p><ul>{excerpts.map((excerpt, index) => <li key={`${index}-${excerpt}`}>“{excerpt}”</li>)}</ul></details>}
    {showEmptyState && !notes.length && !excerpts.length && <p>No call details were recorded.</p>}
  </section>;
}
