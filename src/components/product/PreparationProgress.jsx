import { useEffect, useState } from 'react';
import './meet-bob.css';

// The server reports only that reading is under way, so the page says that and shows the real time spent rather than
// rotating step names that do not match what the server is doing.
const PENDING_MESSAGE = 'Reading your website. This usually takes under a minute.';

function elapsedLabel(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const STAGES = {
  limited_ready: ['Some details are missing', "Check what's missing before you start a call."],
  insufficient_context: ['More information needed', "Couldn't find enough about the business on that website. Try another page."],
  research_unavailable: ["Website reading isn't available right now", 'Please contact the Frontline team.'],
  inspection_unavailable: ['Website reading is unavailable', 'Try again in a few minutes.'],
  origin_mismatch: ["Website reading isn't available right now", 'Please contact the Frontline team.'],
  research_busy: ['Website reading is busy', 'Wait a moment, then try again.'],
  connection_failed: ['Connection lost', "Couldn't reach Frontline. Check your connection, then try again."],
  failed_retryable: ["Couldn't read that website", 'Try again, or use a different website.'],
  blocked: ["That website can't be read", 'Try another public page from the business.'],
};

export default function PreparationProgress({ stage = 'validating', message = undefined, onRetry = undefined, onCancel = undefined }) {
  const isPending = ['validating', 'researching', 'extracting', 'resolving_identity', 'compiling'].includes(stage);
  const canRetry = ['research_unavailable', 'inspection_unavailable', 'origin_mismatch', 'research_busy', 'connection_failed', 'failed_retryable', 'blocked', 'insufficient_context'].includes(stage);

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isPending) return undefined;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isPending]);

  if (isPending) return (
    <div className="bob-page">
      <section className="bob-progress" aria-labelledby="bob-progress-title">
        <div className="bob-progress__mark" aria-hidden="true"><span /></div>
        <div className="bob-progress__content" role="status" aria-live="polite" aria-atomic="true">
          <h1 id="bob-progress-title">Getting the receptionist ready.</h1>
          <p>{message || PENDING_MESSAGE}</p>
        </div>
        {!message && <p className="bob-progress__elapsed" aria-hidden="true">{elapsedLabel(elapsed)}</p>}
        <div className="bob-progress__skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
        {onCancel && <button className="bob-text-button" type="button" onClick={onCancel}>Change website</button>}
      </section>
    </div>
  );

  const [title, defaultMessage] = STAGES[stage] || STAGES.insufficient_context;
  return (
    <div className="bob-page">
      <section className="bob-progress" aria-labelledby="bob-progress-title">
        <div className="bob-progress__content" role={canRetry ? 'alert' : 'status'} aria-live={canRetry ? 'assertive' : 'polite'} aria-atomic="true">
          <h1 id="bob-progress-title">{title}</h1>
          <p>{message || defaultMessage}</p>
        </div>
        <div className="bob-actions">
          {canRetry && onRetry && <button className="bob-button bob-button--primary" type="button" onClick={onRetry}>Try again</button>}
          {onCancel && <button className="bob-button bob-button--quiet" type="button" onClick={onCancel}>Change website</button>}
        </div>
      </section>
    </div>
  );
}
