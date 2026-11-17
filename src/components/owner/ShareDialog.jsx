import { useEffect, useRef, useState } from 'react';
import { newKey, ownerApi } from '../../lib/owner-api.js';
import { Button, Dialog, InlineError, Progress } from './ui.jsx';
import { errorMessage } from '../../pages/owner/error-copy.js';
import { expiresIn, formatDateTime } from '../../pages/owner/format.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import './share-dialog.css';

// PO-S6. A small dialog that shows the links already shared, makes a new one when the owner asks, and revokes any of them.
// Opening it never changes a link. A new link's URL lives in this component's memory only: nothing stores it, logs it,
// or puts it in a title or an aria-label, and the list never carries it. Server-confirmed: the list follows the API.

const MAX_UNUSED_LINKS = 5;
const LIMIT_REASON = 'You already have 5 unused links. Revoke one to create another.';
const isSignedOut = (error) => error?.code === 'sign_in_required' || error?.status === 401;
const isLive = (share) => Date.parse(share.expiresAt) > Date.now();
const isNotUsed = (share) => share.status === 'unused' && isLive(share);
const isInProgress = (share) => (share.status === 'reserved' || share.status === 'active') && isLive(share);

/** Why a link cannot be made, or null. */
function blockedReason(summary, name) {
  if (summary.voiceAvailable === false) return "Sharing isn't available right now. Please contact the Frontline team.";
  if (!summary.ready) return `Add your business details to get ${name} ready.`;
  return null;
}

/** @param {{agentId: string, summary: any, onClose: () => void, onStale?: () => void, signIn?: () => void}} props */
export default function ShareDialog({ agentId, summary, onClose, onStale, signIn }) {
  const name = receptionistName(summary);
  const blocked = blockedReason(summary, name);
  const [shares, setShares] = useState(/** @type {any[]|null} */ (null));
  const [loadError, setLoadError] = useState(/** @type {any} */ (null));
  const [url, setUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(/** @type {any} */ (null));
  const [copy, setCopy] = useState('idle');
  const [confirming, setConfirming] = useState('');
  const [revoking, setRevoking] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const input = useRef(/** @type {HTMLInputElement|null} */ (null));
  const alive = useRef(true);
  const versionId = useRef(summary.currentAgentVersionId);
  versionId.current = summary.currentAgentVersionId;

  async function loadShares() {
    setLoadError(null);
    try {
      const answer = await ownerApi.listShares(agentId);
      if (alive.current) setShares(answer.shares);
      return answer.shares;
    } catch (error) {
      if (alive.current) setLoadError(error);
      return null;
    }
  }

  useEffect(() => {
    alive.current = true;
    if (!blocked) void loadShares();
    return () => { alive.current = false; };
    // Reads the links once when the dialog opens. It changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = (shares ?? []).filter((share) => isNotUsed(share) || isInProgress(share)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const atLimit = (shares ?? []).filter(isNotUsed).length >= MAX_UNUSED_LINKS;
  const canCreate = !blocked && shares !== null && !atLimit;

  async function createLink() {
    setCreating(true); setCreateError(null); setCopy('idle'); setAnnouncement('Creating link');
    try {
      const share = await ownerApi.createShare(agentId, versionId.current, newKey());
      if (!alive.current) return;
      setUrl(share.url ?? ''); setAnnouncement('Link ready');
      await loadShares();
    } catch (error) {
      if (!alive.current) return;
      setAnnouncement('');
      if (error?.code === 'stale_agent_version') onStale?.();
      // A refusal at the cap means this list was out of date. Show it as it is now.
      if (error?.code === 'share_limit_reached') await loadShares();
      setCreateError(error);
    } finally { if (alive.current) setCreating(false); }
  }

  async function revoke(share) {
    setRevoking(share.shareId); setRevokeError('');
    try {
      await ownerApi.revokeShare(agentId, share.shareId, share.version);
      if (!alive.current) return;
      setConfirming(''); setAnnouncement('Link revoked');
      await loadShares();
    } catch (error) {
      if (!alive.current) return;
      if (error?.code === 'stale_share') await loadShares();
      setRevokeError(isSignedOut(error) ? errorMessage(error) : error?.code === 'stale_share' ? 'That link changed. Check the list and try again.' : "Couldn't revoke that link. Try again.");
    } finally { if (alive.current) setRevoking(''); }
  }

  async function copyLink() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopy('copied');
    } catch {
      setCopy('failed');
      input.current?.focus();
      input.current?.select();
    }
  }

  const failureText = blocked ?? (isSignedOut(loadError ?? createError) ? errorMessage(loadError ?? createError)
    : createError?.code === 'share_limit_reached' ? LIMIT_REASON
      : createError?.code === 'voice_unavailable' ? "Sharing isn't available right now. Please contact the Frontline team."
        : createError?.code === 'stale_agent_version' ? `${name} was updated. Close this box and choose Share again.`
          : createError ? "Couldn't create a link. Try again."
            : loadError ? "Couldn't load your links. Try again." : '');
  const signedOut = isSignedOut(loadError ?? createError);

  return <Dialog title="Share" onClose={onClose}>
    <p className="owner-share-dialog__about">{`Anyone with this link can have one conversation with ${name}, up to 5 minutes. No account needed.`}</p>
    <p className="owner-visually-hidden" role="status">{announcement}</p>
    {!blocked && shares === null && !loadError && <Progress>Loading links…</Progress>}
    {url && <>
      <label className="owner-field owner-share-dialog__field">
        <span>New link</span>
        <input ref={input} type="text" readOnly value={url} onFocus={(event) => event.target.select()} />
      </label>
      {copy === 'copied' && <p className="owner-share-dialog__result" role="status">Link copied</p>}
      {copy === 'failed' && <p className="owner-share-dialog__result owner-share-dialog__result--error" role="alert">Couldn&apos;t copy automatically. Select the link and copy it.</p>}
    </>}
    <InlineError>{failureText}</InlineError>
    {atLimit && !failureText && <p className="owner-muted" id="owner-share-limit">{LIMIT_REASON}</p>}
    <div className="owner-actions">
      {url && <Button onClick={copyLink}>Copy link</Button>}
      {signedOut && signIn ? <Button onClick={signIn}>Sign in</Button>
        : !blocked && loadError && shares === null ? <Button onClick={loadShares}>Try again</Button>
          : !blocked && createError?.code !== 'stale_agent_version' && <Button variant={url ? 'secondary' : 'primary'} busy={creating} disabled={!canCreate} aria-describedby={atLimit ? 'owner-share-limit' : undefined} onClick={createLink}>{creating ? 'Creating…' : 'Create link'}</Button>}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </div>
    {active.length > 0 && <section className="owner-share-links" aria-labelledby="owner-share-links-title">
      <h3 id="owner-share-links-title">Active links</h3>
      <ul>
        {active.map((share) => {
          const inProgress = isInProgress(share);
          const asking = confirming === share.shareId;
          return <li key={share.shareId} className="owner-share-links__row">
            <div className="owner-share-links__info">
              <span className="owner-share-links__status">{inProgress ? 'Conversation in progress' : 'Not used yet'}</span>
              <span className="owner-muted">{expiresIn(share.expiresAt)}</span>
            </div>
            {asking
              ? <div className="owner-share-links__confirm">
                <span>This ends the conversation in progress.</span>
                <Button size="small" variant="secondary" onClick={() => setConfirming('')} disabled={Boolean(revoking)}>Cancel</Button>
                <button type="button" className="bob-button bob-button--primary bob-button--small owner-danger" disabled={Boolean(revoking)} onClick={() => revoke(share)}>{revoking === share.shareId ? 'Revoking…' : 'Revoke link'}</button>
              </div>
              : <Button size="small" variant="secondary" disabled={Boolean(revoking)} aria-label={`Revoke link created ${formatDateTime(share.createdAt)}`} onClick={() => { setRevokeError(''); if (inProgress) setConfirming(share.shareId); else void revoke(share); }}>Revoke</Button>}
          </li>;
        })}
      </ul>
      <InlineError>{revokeError}</InlineError>
    </section>}
  </Dialog>;
}
