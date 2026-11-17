// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { Loading, Spinner } from '../../src/components/owner/ui.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { asOwner, fakeVoice, hex64, seedClaimedOwner, seedSession } from './fixtures.js';
import { seedConversations } from './ui-conversations-fixtures.js';
import { devConversationSeeds } from '../../scripts/owner-dev/conversations.mjs';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';

// The shared frame: top bar navigation, the account menu, the loading spinner, and the business-level Knowledge route.

// The business route reads the account, then the receptionist, then its Knowledge, so it can take longer than the default second.
configure({ asyncUtilTimeout: 5000 });

let harness; let browser;
/** Waits for the Home screen to finish loading (the greeting also shows while it loads). */
const homeReady = () => screen.findByRole('link', { name: /^Blake, Riverside Dental/ });
const setCookie = (name, value) => { document.cookie = `${name}=${encodeURIComponent(value)}; Path=/`; };
const setNameCookie = (value) => setCookie('fl_first_name', value);
const PROFILE_COOKIES = ['fl_first_name', 'fl_last_name', 'fl_email'];
afterEach(() => { browser?.restore(); resetOwnerApi(); for (const name of PROFILE_COOKIES) document.cookie = `${name}=; Max-Age=0; Path=/`; });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ handlerContext: { voice: fakeVoice() } }); });

const open = async (path, { authToken = harness.owner.authToken, app = harness.app } = {}) => {
  resetOwnerApi();
  browser = installBrowserFetch({ app, authToken });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => {}} />);
};

describe('Top bar navigation', () => {
  it('has the logo, Home and Knowledge, and no Settings item', async () => {
    await open('/app');
    await homeReady();
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Frontline home' })).toHaveAttribute('href', '/app');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Home', '/app'], ['Knowledge', '/app/knowledge']]);
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Knowledge' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('marks Knowledge as the current section on the business library, and Home on the receptionist Knowledge page', async () => {
    const view = await open('/app/knowledge');
    await screen.findByText('Business details', { selector: '.owner-category__name' });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Knowledge' })).toHaveAttribute('aria-current', 'page');
    view.unmount();
    await open(`/app/agents/${harness.owner.agentId}/knowledge`);
    await screen.findByRole('button', { name: 'Choose sources' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('link', { name: 'Knowledge' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Home as the current section on a receptionist screen and navigates without a reload', async () => {
    await open(`/app/agents/${harness.owner.agentId}/capabilities`);
    await screen.findByText('Email me each request');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(within(nav).getByRole('link', { name: 'Knowledge' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app/knowledge'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
  });

  it('is not shown to a guest', async () => {
    await open('/shared', { authToken: null });
    await screen.findByRole('heading', { level: 1, name: 'Talk to the receptionist' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Frontline home' })).not.toBeInTheDocument();
  });
});

describe('Sidebar layout', () => {
  const sidebarShape = () => {
    const side = document.querySelector('.owner-sidebar');
    return { className: side.className, children: Array.from(side.children).map((item) => item.tagName + (item.getAttribute('aria-label') ?? '')), links: Array.from(side.querySelectorAll('nav a')).map((link) => link.textContent) };
  };

  it('shows the logo, Home, Knowledge and the account button in a left sidebar, identical on every page, with no top bar', async () => {
    const shapes = [];
    for (const path of ['/app', '/app/knowledge', `/app/agents/${harness.owner.agentId}`, '/app/account']) {
      const view = await open(path);
      await screen.findByRole('link', { name: 'Frontline home' });
      await screen.findByRole('button', { name: 'Account menu' });
      expect(document.querySelector('.owner-topbar')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Frontline home' }).closest('.owner-sidebar')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Account menu' }).closest('.owner-sidebar')).toBeInTheDocument();
      shapes.push(sidebarShape());
      view.unmount();
      browser.restore();
    }
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
    expect(shapes[0].links).toEqual(['Home', 'Knowledge']);
    expect(shapes[0].children).toEqual(['AFrontline home', 'NAVMain', 'DIV']);
  });

  it('marks the current item with aria-current', async () => {
    await open('/app/knowledge');
    await screen.findByRole('heading', { level: 1, name: 'Knowledge' });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Knowledge' })).toHaveAttribute('aria-current', 'page');
  });

  it('lays the page out as a sidebar column beside the content, with a tinted pill for the current item and no underline', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/owner/owner.css'), 'utf8');
    expect(css).toMatch(/\.owner-shell--sidebar\{display:grid;grid-template-columns:232px minmax\(0,1fr\)/);
    expect(css).toMatch(/\.owner-sidebar__nav a\[aria-current\]\{[^}]*background:var\(--mint-2\)/);
    expect(css).not.toMatch(/\.owner-sidebar__nav a\[aria-current\]\{[^}]*border-bottom/);
    expect(css).toMatch(/\.owner-topbar__inner\{[^}]*max-width:1120px/);
  });

  it('shows only the logo to a guest', async () => {
    await open('/shared', { authToken: null });
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('.owner-sidebar')).not.toBeInTheDocument();
    expect(document.querySelector('.owner-topbar')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });
});

describe('Account menu', () => {
  it('is a sidebar row with a person icon and the word Account, not the initial', async () => {
    setNameCookie('Zoë');
    await open('/app');
    await homeReady();
    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(button.querySelector('svg')).toBeInTheDocument();
    expect(button).toHaveTextContent('Account');
    expect(button).not.toHaveTextContent('Z');
  });

  it('opens with Account and Sign out, moves focus in, and closes with Escape back on the button', async () => {
    setNameCookie('Zoë');
    await open('/app');
    await homeReady();
    expect(screen.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Zoë$/ })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('group', { name: 'Account' });
    // Two items only: no label and no name block.
    expect(Array.from(panel.children).map((item) => item.textContent)).toEqual(['Account', 'Sign out']);
    expect(within(panel).queryByText('Zoë')).not.toBeInTheDocument();
    const account = within(panel).getByRole('link', { name: 'Account' });
    expect(account).toHaveAttribute('href', '/app/account');
    expect(account).toHaveClass('owner-menu__item');
    expect(account).toHaveFocus();
    expect(within(panel).getByRole('button', { name: 'Sign out' })).toHaveClass('owner-menu__item--signout');
    await userEvent.tab();
    expect(within(panel).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('opens the Account page from the menu and closes the menu', async () => {
    setNameCookie('Zoë');
    await open('/app');
    await homeReady();
    const button = screen.getByRole('button', { name: 'Account menu' });
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole('group', { name: 'Account' })).getByRole('link', { name: 'Account' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app/account'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('opens from the keyboard and closes when a click lands outside', async () => {
    await open('/app');
    await homeReady();
    const button = screen.getByRole('button', { name: 'Account menu' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
  });

  it('shows a person icon and the same two items when no first name is known', async () => {
    await open('/app');
    await homeReady();
    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(button.querySelector('svg')).toBeInTheDocument();
    await userEvent.click(button);
    const panel = screen.getByRole('group', { name: 'Account' });
    expect(Array.from(panel.children).map((item) => item.textContent)).toEqual(['Account', 'Sign out']);
  });

  it('ignores a cookie with malformed encoding', async () => {
    document.cookie = 'fl_first_name=%E0%A4%A; Path=/';
    await open('/app');
    await homeReady();
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });
});

describe('Account page', () => {
  const rows = (card) => Array.from(card.querySelectorAll('dl > div')).map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]);

  it('shows first name, last name and email in labeled rows and a Sign out button, with a back button to Home', async () => {
    setNameCookie('Zoë'); setCookie('fl_last_name', 'O’Brien'); setCookie('fl_email', 'zoe@example.com');
    await open('/app/account');
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Account · Frontline'));
    const card = await screen.findByRole('region', { name: 'Account' });
    expect(rows(card)).toEqual([['First name', 'Zoë'], ['Last name', 'O’Brien'], ['Email', 'zoe@example.com']]);
    expect(within(card).getAllByRole('button').map((item) => item.textContent)).toEqual(['Sign out']);
    expect(within(card).getByRole('button', { name: 'Sign out' })).toHaveClass('bob-button--secondary');
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    // Delete account sits in its own section below, apart from Sign out.
    const danger = screen.getByRole('region', { name: 'Delete account' });
    expect(within(danger).getAllByRole('button').map((item) => item.textContent)).toEqual(['Delete account']);
    expect(card.contains(danger)).toBe(false);
  });

  it('shows only the first name for a session that knows nothing else', async () => {
    setNameCookie('Zoë');
    await open('/app/account');
    const card = await screen.findByRole('region', { name: 'Account' });
    expect(rows(card)).toEqual([['First name', 'Zoë']]);
    expect(within(card).queryByText('Email')).not.toBeInTheDocument();
  });

  it('shows only Sign out when nothing is known', async () => {
    await open('/app/account');
    const card = await screen.findByRole('region', { name: 'Account' });
    expect(within(card).queryByText('First name')).not.toBeInTheDocument();
    expect(card.querySelector('dl')).not.toBeInTheDocument();
    expect(within(card).getAllByRole('button').map((item) => item.textContent)).toEqual(['Sign out']);
  });

  it('signs out from the page and forgets the name and email in this browser', async () => {
    setNameCookie('Zoë'); setCookie('fl_last_name', 'Lee'); setCookie('fl_email', 'zoe@example.com');
    await open('/app/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(browser.calls.some((call) => call.method === 'POST' && call.path === '/v1/auth/logout')).toBe(true));
    await waitFor(() => expect(PROFILE_COOKIES.filter((name) => document.cookie.includes(`${name}=`))).toEqual([]));
  });

  it('asks a visitor who is not signed in to sign in, without the account menu', async () => {
    await open('/app/account', { authToken: null });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see your account.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument();
    expect(screen.queryByText('First name')).not.toBeInTheDocument();
  });
});

describe('Phone menu', () => {
  const narrow = (matches) => { window.matchMedia = () => /** @type {any} */ ({ matches, addEventListener() {}, removeEventListener() {} }); };
  afterEach(() => { delete window.matchMedia; });

  it('replaces the top bar links with one menu button holding Home, Knowledge and the account section', async () => {
    narrow(true);
    setNameCookie('Zoë');
    await open('/app');
    await homeReady();
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Knowledge' })).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Knowledge']);
    const account = screen.getByRole('group', { name: 'Account' });
    expect(Array.from(account.children).map((item) => item.textContent)).toEqual(['Account', 'Sign out']);
    expect(within(account).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/app/account');
    expect(within(account).queryByText('Zoë')).not.toBeInTheDocument();
  });

  it('closes on Escape with focus back on the button, and after choosing a link', async () => {
    narrow(true);
    await open('/app');
    await homeReady();
    const button = screen.getByRole('button', { name: 'Menu' });
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Knowledge' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app/knowledge'));
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes after choosing Account and opens the Account page', async () => {
    narrow(true);
    await open('/app');
    await homeReady();
    const button = screen.getByRole('button', { name: 'Menu' });
    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole('group', { name: 'Account' })).getByRole('link', { name: 'Account' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app/account'));
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the full bar on a wide window', async () => {
    narrow(false);
    await open('/app');
    await homeReady();
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });
});

describe('Loading spinner', () => {
  it('is one status element with hidden text, and the spinner itself is not announced', () => {
    const { container } = render(<Loading>Loading your receptionist…</Loading>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading your receptionist…');
    expect(status).toHaveClass('owner-loading');
    expect(container.querySelector('.owner-spinner')).toHaveAttribute('aria-hidden', 'true');
    expect(within(status).getByText('Loading your receptionist…')).toHaveClass('owner-visually-hidden');
  });

  it('can show its words for a longer wait', () => {
    render(<Loading showLabel>Connecting to Blake…</Loading>);
    expect(screen.getByText('Connecting to Blake…')).not.toHaveClass('owner-visually-hidden');
  });

  it('renders on its own as a decoration', () => {
    const { container } = render(<Spinner />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('turns slowly instead of stopping when the visitor prefers reduced motion', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/owner/owner.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
    expect(reduced).toMatch(/\.owner-spinner\{animation-duration:[\d.]+s\}/);
    expect(reduced).toMatch(/\*:not\(\.owner-spinner\)\{animation:none!important\}/);
  });

  it('replaces plain loading text on a screen', async () => {
    browser = installBrowserFetch({ app: harness.app, authToken: harness.owner.authToken });
    const inner = globalThis.fetch;
    /** @type {(value?: any) => void} */
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (input, init) => { if (String(input).endsWith('/v1/me/agents')) await held; return inner(input, init); };
    try {
      window.history.replaceState({}, '', '/app');
      const { container } = render(<OwnerApp />);
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Loading your receptionist…');
      expect(container.querySelector('.owner-spinner')).toBeInTheDocument();
      expect(status.querySelector('.owner-visually-hidden')).toBeInTheDocument();
      release();
      await screen.findByRole('heading', { level: 1, name: 'Welcome back' });
    } finally { globalThis.fetch = inner; }
  });
});

describe('Business-level Knowledge route', () => {
  it('opens the owner receptionist Knowledge at /app/knowledge', async () => {
    await open('/app/knowledge');
    expect(await screen.findByText('Business details', { selector: '.owner-category__name' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.getByText('Everything Blake can use.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Receptionist sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Back to/ })).not.toBeInTheDocument();
  });

  it('records the open category under the business route, and opens the one named in the address', async () => {
    await open('/app/knowledge/services');
    const services = (await screen.findByText('Services', { selector: '.owner-category__name' })).closest('details');
    await waitFor(() => expect(services.open).toBe(true));
    await userEvent.click(within(screen.getByText('Hours', { selector: '.owner-category__name' }).closest('details')).getByText('Hours', { selector: '.owner-category__name' }));
    expect(window.location.pathname).toBe('/app/knowledge/hours');
  });

  it('opens the receptionist\'s own Knowledge page, not the library, at /app/agents/:id/knowledge', async () => {
    await open(`/app/agents/${harness.owner.agentId}/knowledge`);
    expect(await screen.findByRole('button', { name: 'Choose sources' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Blake' })).toHaveAttribute('href', `/app/agents/${harness.owner.agentId}`);
    expect(screen.queryByText('Business details', { selector: '.owner-category__name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add knowledge' })).not.toBeInTheDocument();
  });

  it('says so when no receptionist is saved to the account', async () => {
    const empty = await createUiHarness({ owners: 0 });
    try {
      const session = await seedSession(empty.pg);
      await open('/app/knowledge', { app: empty.app, authToken: session.authToken });
      expect(await screen.findByRole('heading', { level: 2, name: 'No receptionist yet.' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Set up a receptionist' })).toHaveAttribute('href', '/');
    } finally { await empty.pg.close(); }
  });

  it('points to setup when the only saved thing is an unfinished workspace', async () => {
    const lonely = await createUiHarness({ owners: 0 });
    try {
      const owner = await seedClaimedOwner(lonely.pg);
      await asOwner(lonely.pg, async () => {
        await lonely.pg.query("UPDATE frontline_claimed_targets SET target_kind = 'workspace' WHERE owner_scope_id = $1", [owner.scopeId]);
        await lonely.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify({ workspaces: { [owner.agentId]: { id: owner.agentId, businessName: 'Half Done' } }, agents: {}, demos: {} })]);
      });
      await open('/app/knowledge', { app: lonely.app, authToken: owner.authToken });
      expect(await screen.findByRole('heading', { level: 2, name: 'Knowledge opens once Blake is ready.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Add business details' })).toHaveAttribute('href', `/app/workspaces/${owner.agentId}/setup`);
    } finally { await lonely.pg.close(); }
  });

  it('asks a signed-out visitor to sign in', async () => {
    await open('/app/knowledge', { authToken: null });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see Knowledge.' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('asks a session that belongs to nobody to sign in again', async () => {
    await open('/app/knowledge', { authToken: hex64() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see Knowledge.' })).toBeInTheDocument();
  });
});

describe('Back control', () => {
  it.each([['talk', 'Talk to Blake'], ['test', 'Talk to Blake'], ['feedback', 'Feedback']])('is an icon link to the receptionist at the top of %s', async (screenPath, title) => {
    await open(`/app/agents/${harness.owner.agentId}/${screenPath}`);
    const back = await screen.findByRole('link', { name: 'Back to Blake' });
    expect(back).toHaveAttribute('href', `/app/agents/${harness.owner.agentId}`);
    expect(back).toHaveAttribute('title', 'Back to Blake');
    expect(back.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(back).toHaveTextContent('');
    const heading = screen.getByRole('heading', { level: 1, name: title });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Back control on the receptionist page', () => {
  it('goes to Home', async () => {
    await open(`/app/agents/${harness.owner.agentId}`);
    const back = await screen.findByRole('link', { name: 'Back to Home' });
    expect(back).toHaveAttribute('href', '/app');
    expect(back.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(back).toHaveTextContent('');
  });
});

describe('Shared styles', () => {
  const css = (file) => readFileSync(resolve(process.cwd(), file), 'utf8');
  const ownerFiles = ['src/pages/owner/owner.css', 'src/pages/owner/bob.css', 'src/pages/owner/knowledge.css', 'src/components/owner/conversations.css', 'src/components/owner/call-stage.css', 'src/components/owner/feedback.css', 'src/components/owner/share-guest.css', 'src/components/owner/share-dialog.css'];

  it('sizes every owner button through the shared classes: 40px, and 36px for the small variant', () => {
    const owner = css('src/pages/owner/owner.css');
    expect(owner).toMatch(/\.owner-shell \.bob-button\{[^}]*min-height:40px[^}]*font:650 14px/);
    expect(owner).toMatch(/\.owner-shell \.bob-button--small\{[^}]*min-height:36px/);
    expect(css('src/components/owner/call-stage.css')).toMatch(/\.owner-call__actions button\{min-height:40px/);
    for (const file of ownerFiles) expect(css(file), file).not.toMatch(/\.bob-button[^{]*\{[^}]*min-height:(4[4-9]|5\d)px/);
  });

  it('sets page headings between 24px and 28px on desktop and the description lighter than section headings', () => {
    const owner = css('src/pages/owner/owner.css');
    expect(owner).toMatch(/\.owner-main h1\{font:600 28px\//);
    expect(owner).toMatch(/\.owner-main h1\{font-size:24px\}/);
    expect(owner).toMatch(/\.owner-lede\{font:400 15px[^}]*color:var\(--muted\)/);
    expect(owner).toMatch(/\.owner-main h2\{font:600 /);
  });

  it('draws no underline on any owner link', () => {
    expect(css('src/pages/owner/owner.css')).toMatch(/\.owner-shell a,\.owner-shell a:hover,\.owner-shell a:focus\{text-decoration:none!important\}/);
    for (const file of ownerFiles) expect(css(file), file).not.toMatch(/text-decoration:\s*underline/);
  });
});

describe('Development conversation seeds', () => {
  it('give the list and a conversation detail real content to review', async () => {
    const seeded = await createUiHarness({ owners: 1, handlerContext: { voice: fakeVoice() } });
    try {
      await seedConversations(seeded.pg, seeded.owner, devConversationSeeds());
      const view = await open(`/app/agents/${seeded.owner.agentId}/conversations`, { app: seeded.app, authToken: seeded.owner.authToken });
      const list = await screen.findByRole('list', { name: 'Conversations' });
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(10);
      const text = rows.map((row) => row.textContent);
      for (const kind of ['Your call', 'Shared link']) expect(text.some((row) => row.includes(kind)), kind).toBe(true);
      for (const status of ['Complete', 'Ended early', 'Interrupted']) expect(text.some((row) => row.includes(status)), status).toBe(true);
      expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
      const firstPath = rows[0].querySelector('a').getAttribute('href');
      view.unmount();
      await open(`/app/agents/${seeded.owner.agentId}/conversations/${firstPath.split('/').at(-1)}`, { app: seeded.app, authToken: seeded.owner.authToken });
      expect(await screen.findByRole('heading', { level: 2, name: 'Transcript' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Outcomes' })).toBeInTheDocument();
      expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    } finally { await seeded.pg.close(); }
  });
});
