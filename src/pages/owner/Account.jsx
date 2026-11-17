import { useId, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { clearOwnerProfile, ownerProfile } from '../../lib/owner-name.js';
import { BackButton, Button, Dialog, InlineError, Loading, Notice, Shell, Spinner, clearOwnerSessionStorage, signOut } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { errorMessage } from './error-copy.js';

// PO-S18. The account page, opened from the account menu. It shows what sign-in knows about the owner (first name,
// last name and email, each only when known), offers Sign out, and, in a separate section, Delete account (PO-D12).
// There are no settings to change.

const DETAILS = /** @type {const} */ ([['First name', 'firstName'], ['Last name', 'lastName'], ['Email', 'email']]);
const CONFIRM_WORD = 'DELETE';
const ERASED = [
  'All your receptionists',
  'Their call transcripts and summaries',
  'What they know about your business',
  'Your share links',
  'The link between your Google sign-in and Frontline',
];

/** Where the browser goes once the account is gone: the public home page, which shows a short confirmation. */
export const ACCOUNT_DELETED_PATH = '/?account=deleted';
/** A full page load, so nothing from the signed-in app stays in memory. An object so a browser test can watch it. */
export const accountExit = { leave: (/** @type {string} */ path) => window.location.assign(path) };

/** @param {{signIn?: () => void}} props */
export default function Account({ signIn }) {
  // Any owner request answers 401 for a visitor who is not signed in, so this is how the page knows.
  const load = useLoad((signal) => ownerApi.listMyAgents(signal), []);
  const [profile] = useState(() => ownerProfile());
  const [deleting, setDeleting] = useState(false);
  const signedOut = load.error?.code === 'sign_in_required' || load.error?.status === 401;
  const known = DETAILS.filter(([, key]) => profile[key]);
  usePageTitle('Account', load.status !== 'loading');
  return <Shell signedOut={signedOut}>
    {signedOut ? <><h1>Sign in to see your account.</h1><Button onClick={signIn}>Sign in</Button></> : <>
      <BackButton to="/app" label="Back to Home" />
      <h1>Account</h1>
      {load.status === 'loading' && <Loading>Loading your account…</Loading>}
      {load.status === 'error' && <Notice kind="error" title="Couldn't load your account." action={<Button variant="secondary" onClick={load.reload}>Try again</Button>}>{errorMessage(load.error)}</Notice>}
      {load.status === 'ready' && <>
        <section className="owner-card owner-account-page" aria-label="Account">
          {known.length > 0 && <dl className="owner-account-page__details">
            {known.map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{profile[key]}</dd></div>)}
          </dl>}
          <div className="owner-actions"><Button variant="secondary" onClick={signOut}>Sign out</Button></div>
        </section>
        <section className="owner-card owner-account-delete" aria-labelledby="owner-account-delete-heading">
          <h2 id="owner-account-delete-heading">Delete account</h2>
          <p>Permanently erase your receptionists, their conversations and everything Frontline keeps for your business.</p>
          <div className="owner-actions"><Button variant="secondary" onClick={() => setDeleting(true)}>Delete account</Button></div>
        </section>
      </>}
      {deleting && <DeleteAccountDialog onCancel={() => setDeleting(false)} />}
    </>}
  </Shell>;
}

/**
 * PO-D12. Lists what is erased, says it cannot be undone, and enables the destructive button only once the owner types
 * DELETE. Cancel has focus first. On success the browser is signed out and leaves for the public home page.
 * @param {{onCancel: () => void}} props
 */
export function DeleteAccountDialog({ onCancel }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldId = useId(); const noteId = useId(); const errorId = useId();
  const confirmed = value.trim() === CONFIRM_WORD;

  async function remove(event) {
    event?.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true); setError('');
    try {
      await ownerApi.deleteAccount();
    } catch (failure) {
      setBusy(false);
      setError(errorMessage(failure, { fallback: "Couldn't delete your account. Try again." }));
      return;
    }
    // The server already ended every session and cleared the sign-in cookies. Local drafts and names go too.
    clearOwnerSessionStorage();
    clearOwnerProfile();
    accountExit.leave(ACCOUNT_DELETED_PATH);
  }

  return <Dialog title="Delete your account?" onClose={onCancel} busy={busy} defaultFocus="cancel">
    <form noValidate onSubmit={remove}>
      <p id={noteId}>This permanently erases:</p>
      <ul className="owner-account-delete__list">{ERASED.map((item) => <li key={item}>{item}</li>)}</ul>
      <p>This can&apos;t be undone. Feedback you already sent to the Frontline team is deleted on its own after 30 days.</p>
      <div className="owner-field">
        <label htmlFor={fieldId}>Type {CONFIRM_WORD} to confirm</label>
        <input id={fieldId} type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} value={value} disabled={busy}
          onChange={(event) => { setValue(event.target.value); setError(''); }}
          aria-describedby={error ? `${noteId} ${errorId}` : noteId} />
        <InlineError id={errorId}>{error}</InlineError>
      </div>
      <div className="owner-actions">
        <button type="button" className="bob-button bob-button--secondary" data-dialog-cancel onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="bob-button bob-button--primary owner-danger" disabled={!confirmed || busy}>{busy && <Spinner />}{busy ? 'Deleting account…' : 'Delete account'}</button>
      </div>
    </form>
  </Dialog>;
}
