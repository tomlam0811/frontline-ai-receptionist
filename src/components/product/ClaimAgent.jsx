import { useCallback, useEffect, useState } from 'react';
import { frontlineApi } from '../../lib/frontline-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';

function claimError(error) {
  if (error?.status === 404 || error?.status === 503) return "Saving isn't available in this preview yet. Your receptionist stays open in this browser for now.";
  if (error?.code === 'claim_expired' || error?.code === 'workspace_expired') return 'This receptionist has expired. Enter your website again to set up a new one.';
  if (error?.status === 409) return 'This demo may already be saved. Sign in with the same account, or start a new demo.';
  return error?.message || "Couldn't continue. Try again.";
}

function confirmedResource(response, isFallback) {
  if (response?.state !== 'claimed') return null;
  if (response.kind === 'agent' && !isFallback && typeof response.agentId === 'string') return { kind: 'agent', id: response.agentId };
  if (response.kind === 'workspace' && isFallback && typeof response.workspaceId === 'string') return { kind: 'workspace', id: response.workspaceId };
  return null;
}

export default function ClaimAgent({ demoId, mode, businessName, onBack, onRestart, onClaimed, name = receptionistName() }) {
  const [intent, setIntent] = useState(null);
  const [status, setStatus] = useState('loading');
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState('');
  const isFallback = mode === 'frontline_qa';

  useEffect(() => {
    if (!demoId) { setStatus('unavailable'); setMessage('No finished demo to save.'); return undefined; }
    const controller = new AbortController();
    setStatus('loading');
    frontlineApi.getClaimIntent(demoId, controller.signal).then((response) => {
      if (!response?.claimIntentId || response.claimable !== true) throw new Error("This receptionist can't be saved yet.");
      setIntent(response);
      setStatus('ready');
    }).catch(async (error) => {
      if (controller.signal.aborted) return;
      // The database claim is idempotent for the same verified subject and
      // grant. Recover when its success response was lost before the browser
      // stored the exact claimed resource pointer.
      try {
        const recovered = confirmedResource(await frontlineApi.completeClaim(demoId, controller.signal), isFallback);
        if (recovered && !controller.signal.aborted) { onClaimed(recovered); return; }
      } catch { /* The unsaved receptionist can still be retried or restarted. */ }
      if (controller.signal.aborted) return;
      setStatus('unavailable');
      setMessage(claimError(error));
    });
    return () => controller.abort();
  }, [demoId, isFallback, onClaimed]);

  async function beginGoogle() {
    if (!intent?.claimIntentId || !consent || status === 'saving') return;
    setStatus('saving');
    setMessage('');
    try {
      const response = await frontlineApi.startGoogleClaim(intent.claimIntentId);
      const url = new URL(response?.authorizationUrl || '', window.location.origin);
      if (!response?.authorizationUrl || url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') {
        throw new Error("Google sign-in isn't available right now. Try again later.");
      }
      window.location.assign(url.href);
    } catch (error) {
      setStatus('ready');
      setMessage(claimError(error));
    }
  }

  const finishClaim = useCallback(async () => {
    if (!intent?.claimIntentId || status === 'saving') return;
    setStatus('saving');
    setMessage('Saving the receptionist…');
    try {
      const response = await frontlineApi.completeClaim(intent.claimIntentId);
      const resource = confirmedResource(response, isFallback);
      if (!resource) throw new Error("Couldn't confirm the save. Try again.");
      onClaimed(resource);
    } catch (error) {
      setStatus('verification');
      setMessage(claimError(error));
    }
  }, [intent, isFallback, onClaimed, status]);

  useEffect(() => {
    if (!intent || status !== 'ready') return;
    const auth = new URLSearchParams(window.location.search).get('auth');
    if (!auth) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (auth === 'google-complete') void finishClaim();
    else if (auth === 'google-error') setMessage("Google sign-in didn't finish. Try again.");
  }, [intent, status, finishClaim]);

  return <main className="bob-page claim-page" aria-labelledby="claim-title">
    <section className="bob-intro">
      <p className="bob-eyebrow">Save</p>
      <h1 id="claim-title">{isFallback ? 'Keep this Frontline conversation.' : `Save ${name} for ${businessName || 'your business'}.`}</h1>
      <p>{isFallback
        ? 'Business details are still missing. Sign in to save this conversation and add them later.'
        : `Create an account to save ${name} and this call. Setup starts with what Frontline found on your website.`}</p>
    </section>
    <section className="claim-card" aria-label="Account creation">
      <h2>Continue with Google</h2>
      <p className="claim-card__hint">Google asks you to confirm your identity before your receptionist is saved to your account.</p>
      {status === 'loading' && <p role="status">Checking whether this receptionist can be saved…</p>}
      {status === 'unavailable' && <p className="claim-message" role="alert">{message}</p>}
      {intent && <>
        {status !== 'verification' && <div>
          <label className="claim-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={status === 'saving'} /> <span>I agree to save this receptionist and its business information to my account.</span></label>
          <div className="bob-actions"><button type="button" className="bob-button bob-button--primary" onClick={beginGoogle} disabled={!consent || status === 'saving'}>Continue with Google</button></div>
        </div>}
        {status === 'verification' && <div className="claim-verification"><p>{"Signed in, but the save didn't finish."}</p><button type="button" className="bob-button bob-button--primary" onClick={finishClaim}>Save again</button></div>}
        {message && status !== 'unavailable' && <p className="claim-message" role="alert">{message}</p>}
      </>}
    </section>
    <div className="bob-actions claim-page__back"><button type="button" className="bob-button bob-button--quiet" onClick={onBack}>Go back</button>{status === 'unavailable' && <button type="button" className="bob-button bob-button--secondary" onClick={onRestart}>Start over</button>}</div>
  </main>;
}
