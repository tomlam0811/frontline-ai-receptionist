import { useEffect, useId, useRef, useState } from 'react';
import { Logo } from '../landing/Logo.jsx';
import { AppLink, useLocation } from '../../pages/owner/router.jsx';
import { ownerApi } from '../../lib/owner-api.js';
import { clearOwnerProfile } from '../../lib/owner-name.js';

// Shared pieces of the owner and guest screens (design spec PO-DC2, PO-DC19 and the layout rules).
// Classes are prefixed `owner-`; the existing bob-* button and notice classes are reused unchanged.

const DRAFT_KEY_PREFIX = 'frontline.draft.';
const GUEST_STARTED_KEY = 'frontline.guest.started';

/** Removes the draft and guest-started session-storage keys the connection guide documents for sign-out. */
export function clearOwnerSessionStorage() {
  try {
    const stale = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key && (key.startsWith(DRAFT_KEY_PREFIX) || key === GUEST_STARTED_KEY)) stale.push(key);
    }
    stale.forEach((key) => window.sessionStorage.removeItem(key));
  } catch { /* the page works without it */ }
}

/** Revokes the session on the server, clears local draft state, then hands the page back to the sign-in gate. */
/** Ends the session and returns to the app's start. Local drafts are cleared even when the server call fails. */
export async function signOut() {
  try { await ownerApi.logout(); } catch { /* local state is cleared and the page reloads either way */ }
  clearOwnerSessionStorage();
  clearOwnerProfile();
  window.location.assign('/app');
}

const CHIPS = {
  active: ['Active', '✓', 'owner-chip--saved'],
  updating: ['Updating', '…', 'owner-chip--processing'],
  saved: ['Saved', '✓', 'owner-chip--saved'],
  processing: ['In progress', '…', 'owner-chip--processing'],
  used: ['In use', '✓', 'owner-chip--used'],
  untested: ['Not tested', '!', 'owner-chip--warning'],
  tested: ['Tested', '✓', 'owner-chip--saved'],
  reviewed: ['Reviewed by you', '✓', 'owner-chip--used'],
  paused: ['Paused', '‖', 'owner-chip--plain'],
  deleting: ['Deleting', '…', 'owner-chip--processing'],
  needsKnowledge: ['Needs knowledge', '!', 'owner-chip--warning'],
  attention: ['Needs attention', '!', 'owner-chip--danger'],
  unused: ['Unused', '○', 'owner-chip--plain'],
  progress: ['In progress', '…', 'owner-chip--processing'],
  usedLink: ['Used', '✓', 'owner-chip--plain'],
  expired: ['Expired', '–', 'owner-chip--plain'],
  revoked: ['Revoked', '–', 'owner-chip--plain'],
};

/** PO-DC2. The label is fixed text; color never carries the status alone. */
export function StatusChip({ kind }) {
  const [label, icon, tone] = CHIPS[kind] ?? CHIPS.saved;
  return <span className={`owner-chip ${tone}`}><span aria-hidden="true">{icon}</span> {label}</span>;
}

/** Inline icons: one stroke style, sized by the caller's CSS. */
export function Icon({ name }) {
  const paths = {
    back: <path d="M15 5l-7 7 7 7" />,
    person: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    home: <><path d="M4 11l8-7 8 7" /><path d="M6 10v10h12V10" /><path d="M10 20v-5h4v5" /></>,
    book: <><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h11" /></>,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    more: <><circle cx="12" cy="5.5" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="18.5" r="1.5" fill="currentColor" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" /></>,
    document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></>,
    note: <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><circle cx="12" cy="7.8" r=".6" fill="currentColor" /></>,
  };
  return <svg className="owner-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

/**
 * Open and close behavior shared by the small menus: Escape closes and returns focus to the button,
 * a press outside closes, focus leaving the menu closes, and opening moves focus to the first item.
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef(/** @type {HTMLDivElement|null} */ (null));
  const trigger = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    /** @type {HTMLElement|null|undefined} */ (document.getElementById(panelId)?.querySelector('a[href],button:not([disabled])'))?.focus();
  }, [open, panelId]);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  const close = () => setOpen(false);
  const rootProps = {
    ref: root,
    onKeyDown(event) {
      if (event.key !== 'Escape' || !open) return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    },
    onBlur(event) { if (open && event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false); },
  };
  /** Moves focus back to the button first, so a dialog opened from an item returns focus there when it closes. */
  const closeFromItem = (event) => {
    if (!event.target.closest('.owner-menu__item')) return;
    trigger.current?.focus();
    setOpen(false);
  };
  return { open, setOpen, close, panelId, trigger, rootProps, closeFromItem };
}

/** True while the window is 640px wide or narrower (phones). Renders as wide where matchMedia does not exist. */
function useNarrow() {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/** The two account items, shared by the account menu and the phone menu: a link to the Account page, and Sign out. */
function AccountItems() {
  return <>
    <MenuItem to="/app/account">Account</MenuItem>
    <button type="button" className="owner-menu__item owner-menu__item--signout" onClick={signOut}>Sign out</button>
  </>;
}

/** The person button in the top bar (a rounded square). It opens a small panel with Account and Sign out. */
function AccountMenu({ labeled = false }) {
  const menu = useMenu();
  const { pathname } = useLocation();
  return <div className={`owner-account ${labeled ? 'owner-account--labeled' : ''}`} {...menu.rootProps}>
    <button ref={menu.trigger} type="button" className="owner-account__button" aria-expanded={menu.open} aria-controls={menu.panelId} aria-label="Account menu" title="Account" aria-current={labeled && ACCOUNT_PATH.test(pathname) ? 'true' : undefined} onClick={() => menu.setOpen((value) => !value)}>
      <Icon name="person" />{labeled && <span aria-hidden="true">Account</span>}
    </button>
    {menu.open && <div id={menu.panelId} className="owner-account__panel" role="group" aria-label="Account" onClick={menu.closeFromItem}>
      <AccountItems />
    </div>}
  </div>;
}

const KNOWLEDGE_PATH = /^\/app\/knowledge(\/|$)/;
const ACCOUNT_PATH = /^\/app\/account(\/|$)/;

/**
 * Home and Knowledge links, marked with aria-current for the page the owner is on.
 * @param {{onNavigate?: () => void, icons?: boolean}} props
 */
function MainLinks({ onNavigate, icons = false }) {
  const { pathname } = useLocation();
  const inKnowledge = KNOWLEDGE_PATH.test(pathname);
  const inAccount = ACCOUNT_PATH.test(pathname);
  const current = (target, active) => (pathname.replace(/\/$/, '') === target ? 'page' : active ? 'true' : undefined);
  return <>
    <AppLink to="/app" aria-current={current('/app', !inKnowledge && !inAccount)} onClick={onNavigate}>{icons && <Icon name="home" />}Home</AppLink>
    <AppLink to="/app/knowledge" aria-current={current('/app/knowledge', inKnowledge)} onClick={onNavigate}>{icons && <Icon name="book" />}Knowledge</AppLink>
  </>;
}

/** On a phone the links and account section sit behind one menu button. */
function PhoneMenu() {
  const menu = useMenu();
  return <div className="owner-phone-menu" {...menu.rootProps}>
    <button ref={menu.trigger} type="button" className="owner-account__button" aria-expanded={menu.open} aria-controls={menu.panelId} aria-label="Menu" onClick={() => menu.setOpen((value) => !value)}>
      <Icon name={menu.open ? 'close' : 'menu'} />
    </button>
    {menu.open && <div id={menu.panelId} className="owner-phone-menu__panel">
      <nav aria-label="Main" className="owner-phone-menu__links"><MainLinks onNavigate={menu.close} /></nav>
      <div className="owner-phone-menu__account" role="group" aria-label="Account" onClick={menu.closeFromItem}><AccountItems /></div>
    </div>}
  </div>;
}

/** Top bar: the logo, and on phones one menu button. Guests and the sign-in screen see the logo only. Signed-in owners on wider screens use the sidebar instead. */
function TopBar({ guest, menu }) {
  return <header className="owner-topbar">
    <div className="owner-topbar__inner">
      {guest ? <span className="owner-topbar__brand"><Logo /></span> : <AppLink className="owner-topbar__brand" to="/app" aria-label="Frontline home"><Logo /></AppLink>}
      {menu && <PhoneMenu />}
    </div>
  </header>;
}

/** Left sidebar for signed-in owners: the logo, Home and Knowledge, and the account menu at the bottom. */
function Sidebar() {
  return <aside className="owner-sidebar">
    <AppLink className="owner-sidebar__brand" to="/app" aria-label="Frontline home"><Logo /></AppLink>
    <nav className="owner-sidebar__nav" aria-label="Main"><MainLinks icons /></nav>
    <AccountMenu labeled />
  </aside>;
}

/**
 * A three-dot button that opens a short list of actions. Put `MenuItem`s inside.
 * @param {{label?: string, children?: any}} props
 */
export function OverflowMenu({ label = 'More actions', children }) {
  const menu = useMenu();
  return <div className="owner-overflow" {...menu.rootProps}>
    <button ref={menu.trigger} type="button" className="owner-icon-button" aria-expanded={menu.open} aria-controls={menu.panelId} aria-label={label} title={label} onClick={() => menu.setOpen((value) => !value)}>
      <Icon name="more" />
    </button>
    {menu.open && <div id={menu.panelId} className="owner-account__panel owner-overflow__panel" role="group" aria-label={label} onClick={menu.closeFromItem}>{children}</div>}
  </div>;
}

/**
 * One action in an `OverflowMenu`: a link when `to` is set, otherwise a button.
 * @param {any} props
 */
export function MenuItem({ to, children, ...props }) {
  return to
    ? <AppLink className="owner-menu__item" to={to} {...props}>{children}</AppLink>
    : <button type="button" className="owner-menu__item" {...props}>{children}</button>;
}

/** A short tip with an icon, for the one instruction a page needs. Not a page subheader. */
export function Tip({ children }) {
  return <p className="owner-tip"><Icon name="info" /><span>{children}</span></p>;
}

/**
 * Page frame: skip link, the sidebar (or the top bar on phones and for guests), one main landmark. `guest` shows the mark as plain text, never a link to /app.
 * `signedOut` hides the navigation and account menu on a screen that only asks the visitor to sign in.
 */
export function Shell({ children, guest = false, wide = false, signedOut = false }) {
  const narrow = useNarrow();
  const full = !guest && !signedOut;
  const sidebar = full && !narrow;
  const main = <main id="main" className={`owner-main ${wide ? 'owner-main--wide' : ''}`}>{children}</main>;
  return <div className={`trial-shell owner-shell ${sidebar ? 'owner-shell--sidebar' : ''}`}>
    <a className="owner-skip" href="#main">Skip to main content</a>
    {sidebar ? <><Sidebar /><div className="owner-shell__body">{main}</div></> : <><TopBar guest={guest} menu={full && narrow} />{main}</>}
  </div>;
}

/** The signed-out screen: one title, one line and the one action. */
export function SignInPrompt({ onSignIn }) {
  return <section className="owner-card owner-signin">
    <h1>Sign in to see your receptionist.</h1>
    <p className="owner-lede">Use the Google account you signed up with.</p>
    <Button onClick={onSignIn}>Sign in</Button>
  </section>;
}

/** An icon-only back control at the top of a page. It is a link, so it works with the keyboard, a new tab and copy address. */
export function BackButton({ to, label }) {
  return <p className="owner-back"><AppLink className="owner-back__button" to={to} aria-label={label} title={label}><Icon name="back" /></AppLink></p>;
}

/** @param {{kind?: string, title?: any, children?: any, action?: any}} props */
export function Notice({ kind = 'info', title, children, action }) {
  return <div className={`owner-notice owner-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    <span className="owner-notice__icon" aria-hidden="true">{kind === 'error' || kind === 'warning' ? '!' : 'i'}</span>
    <div>{title && <strong>{title}</strong>}{children && <p>{children}</p>}{action}</div>
  </div>;
}

/** @param {{title?: any, children?: any, action?: any}} props */
export function EmptyState({ title, children, action }) {
  return <section className="owner-empty"><h2>{title}</h2>{children && <p>{children}</p>}{action}</section>;
}

/** @param {{id?: string, children?: any}} props */
export function InlineError({ id, children }) {
  return children ? <p id={id} className="owner-inline-error" role="alert">{children}</p> : null;
}

/** The one loading spinner. It is decoration; the words next to it carry the meaning. */
export function Spinner() {
  return <span className="owner-spinner" aria-hidden="true" />;
}

/**
 * The one loading indicator. `children` is the accessible label, hidden from view unless `showLabel` is set
 * (a wait long enough that the owner should read what is happening).
 * @param {{children?: any, showLabel?: boolean}} props
 */
export function Loading({ children = 'Loading', showLabel = false }) {
  return <p className="owner-loading" role="status"><Spinner /><span className={showLabel ? 'owner-loading__label' : 'owner-visually-hidden'}>{children}</span></p>;
}

/** Spinner with a visible status line, for work in progress that is not a page load (saving, reading). */
export function Progress({ children }) {
  return <p className="owner-progress" role="status"><Spinner /><span>{children}</span></p>;
}

/** @param {any} props `size="small"` is the compact variant for actions inside cards. */
export const Button = ({ variant = 'primary', size = 'default', busy = false, children, ...props }) => (
  <button type="button" className={`bob-button bob-button--${variant === 'primary' ? 'primary' : 'secondary'}${size === 'small' ? ' bob-button--small' : ''}`} {...props} disabled={props.disabled || busy}>{busy && <Spinner />}{children}</button>
);

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog (design spec, Interaction rules): labelled by its heading, focus moves to the heading on open,
 * Tab is trapped, Esc closes unless a save is running, focus returns to the control that opened it.
 * @param {any} props
 */
export function Dialog({ title, onClose, busy = false, children, defaultFocus = 'heading' }) {
  const ref = useRef(null);
  const headingId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    const selector = defaultFocus === 'cancel' ? '[data-dialog-cancel]' : defaultFocus === 'field' ? 'input:not([disabled]), textarea:not([disabled])' : `#${CSS.escape(headingId)}`;
    const target = ref.current.querySelector(selector);
    target?.focus();
    return () => { if (opener instanceof HTMLElement && document.contains(opener)) opener.focus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function onKeyDown(event) {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]; const last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement.id === headingId)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="owner-dialog-backdrop">
    <div ref={ref} className="owner-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <h2 id={headingId} tabIndex={-1}>{title}</h2>
      {children}
    </div>
  </div>;
}

/** PO-DC19. Names the object, states the consequence, and labels the destructive action with its verb. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel, busy = false, error = '' }) {
  return <Dialog title={title} onClose={onCancel} busy={busy} defaultFocus="cancel">
    <p>{body}</p>
    <InlineError>{error}</InlineError>
    <div className="owner-actions">
      <button type="button" className="bob-button bob-button--secondary" data-dialog-cancel onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="bob-button bob-button--primary owner-danger" onClick={onConfirm} disabled={busy}>{busy && <Spinner />}{busy ? `${confirmLabel}…` : confirmLabel}</button>
    </div>
  </Dialog>;
}

/** Live count under a textarea, as words ("412 of 1,000"). */
export const CharacterCount = ({ value, max }) => <span className="owner-count">{value.length.toLocaleString('en-US')} of {max.toLocaleString('en-US')}</span>;
