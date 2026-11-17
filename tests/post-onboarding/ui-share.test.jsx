// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner, startServer } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { demoIds, guestFetch, terminalPath, tokenOf, workerReady } from './ui-calls.js';

configure({ asyncUtilTimeout: 10000 });

// Real handler, real migrated Postgres, real pages. Only the paid LiveKit provider is faked (fakeVoice).
let harness; let browser; let voice; let endedLive; let nextIndex = 0;
const nextOwner = () => harness.owners[nextIndex++];

beforeAll(async () => {
  voice = fakeVoice(); endedLive = [];
  let terminal;
  harness = await createUiHarness({
    owners: 32,
    handlerContext: {
      voice, endGuestDemo: (call) => terminal(call), endLiveCall: async (call) => { endedLive.push(call); await terminal(call); },
      guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 100_000, reservedCents: 100, globalConcurrent: 50 },
    },
  });
  terminal = terminalPath(harness.pg);
  harness.terminal = terminal;
  harness.guest = guestFetch(harness.app);
});
afterEach(() => { browser?.restore(); resetOwnerApi(); voice.failStart = false; vi.restoreAllMocks(); });
afterAll(async () => { await harness?.pg.close(); });

const sharePath = (owner) => `/app/agents/${owner.agentId}/share`;
const open = async (owner, path = bobPath(owner), { signedIn = true, app = harness.app } = {}) => {
  browser = installBrowserFetch({ app, authToken: signedIn ? owner.authToken : null });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => { window.__signIn = true; }} />);
};
const bobPath = (owner) => `/app/agents/${owner.agentId}`;
const linkField = () => /** @type {HTMLInputElement} */ (screen.getByRole('textbox', { name: 'New link' }));
const readLink = async () => { await screen.findByRole('textbox', { name: 'New link' }); return linkField().value; };
/** Waits for the dialog to finish reading the owner's links, so the Create link button is ready. */
const createButton = async () => { const button = await screen.findByRole('button', { name: 'Create link' }); await waitFor(() => expect(button).toBeEnabled()); return button; };
const createLink = async (user) => { await user.click(await createButton()); return readLink(); };
const activeRows = () => within(screen.getByRole('dialog', { name: 'Share' })).queryAllByRole('listitem');
const expireLink = (shareId) => asOwner(harness.pg, () => harness.pg.query("UPDATE frontline_share_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [shareId]));
/** Opens the Share dialog the way an owner does: the three-dot menu on the receptionist page. */
const openShare = async (user) => {
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  await user.click(screen.getByRole('button', { name: 'Share' }));
};
const statuses = async (owner) => (await grantRows(owner)).map((grant) => grant.status);
const ownerAtNewVersion = async (owner, newVersion) => asOwner(harness.pg, async () => {
  const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
  state.agents[newVersion] = { ...state.agents[owner.agentId], id: newVersion };
  const knowledgeRevisionId = state.agents[owner.agentId].knowledgeRevisionId;
  const revision = (agentVersionId, parentAgentVersionId, kind) => ({ agentVersionId, knowledgeRevisionId, parentAgentVersionId, kind, createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null });
  state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, pointerGeneration: 2, currentAgentVersionId: newVersion, revisions: [revision(owner.agentId, null, 'initial'), revision(newVersion, owner.agentId, 'knowledge')] } };
  await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
});
const apiClient = (owner) => browserClient(harness.app, owner.authToken);
const createViaApi = async (owner) => (await apiClient(owner).request('POST', `/v1/agents/${owner.agentId}/shares`, { body: { expectedAgentVersionId: owner.agentId } })).json();
const grantRows = (owner) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT * FROM frontline_share_grants WHERE owner_scope_id = $1 ORDER BY created_at', [owner.scopeId])).rows);
const asGuest = async (url) => {
  const opened = await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(url) } });
  return { opened, cookie: (opened.headers.get('set-cookie') ?? '').split(';')[0] };
};

describe('Share dialog (PO-S6)', () => {
  it('opens with a Create link button and changes nothing until it is pressed', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await openShare(user);
    const dialog = await screen.findByRole('dialog', { name: 'Share' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Anyone with this link can have one conversation with Blake, up to 5 minutes. No account needed.')).toBeInTheDocument();
    await createButton();
    // Nothing made, nothing listed, no empty-state text.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/Active links|No links|Version|Unused/i);
    expect(await grantRows(owner)).toHaveLength(0);
  });

  it('makes one link when Create link is pressed and shows it read-only with a Copy link button', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await openShare(user);
    const url = await createLink(user);
    const dialog = screen.getByRole('dialog', { name: 'Share' });
    expect(linkField()).toHaveAttribute('readonly');
    expect(url).toMatch(/^http:\/\/frontline\.test\/shared#t=[A-Za-z0-9_-]{43}$/);
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    const [grant] = await grantRows(owner);
    expect(await grantRows(owner)).toHaveLength(1);
    expect(grant).toMatchObject({ status: 'unused', agent_version_id: owner.agentId });
    expect(grant.token_hash).not.toContain(tokenOf(url));
    // The new link joins the list without its secret.
    const rows = await within(dialog).findAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Not used yet');
    expect(rows[0]).toHaveTextContent('Expires in 24 hr');
    expect(rows[0].textContent).not.toContain(tokenOf(url));
  });

  it('lasts 24 hours', async () => {
    const owner = nextOwner();
    const share = await createViaApi(owner);
    const hours = (Date.parse(share.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9); expect(hours).toBeLessThanOrEqual(24);
  });

  it('closes with Close or Escape and returns focus to the menu button', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    const menuButton = await screen.findByRole('button', { name: 'More actions' });
    await openShare(user);
    await createButton();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
    await openShare(user);
    await createButton();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it('keeps links that are already shared: opening and creating revoke nothing', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const first = await createViaApi(owner);
    await createViaApi(owner);
    await open(owner);
    await openShare(user);
    await createButton();
    await waitFor(() => expect(activeRows()).toHaveLength(2));
    expect(await statuses(owner)).toEqual(['unused', 'unused']);
    await createLink(user);
    await waitFor(() => expect(activeRows()).toHaveLength(3));
    expect(await statuses(owner)).toEqual(['unused', 'unused', 'unused']);
    // The first link still opens for a guest.
    expect((await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(first.url) } })).status).toBe(200);
  });

  it('lists links that are not used or in progress, with plain status and expiry, and no secrets', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const running = await createViaApi(owner);
    const { cookie } = await asGuest(running.url);
    const { demoId } = await (await harness.guest('/v1/shared/start', { cookie })).json();
    await workerReady(harness.pg, owner.scopeId, demoId);
    const fresh = await createViaApi(owner);
    const revoked = await createViaApi(owner);
    await apiClient(owner).request('DELETE', `/v1/agents/${owner.agentId}/shares/${revoked.shareId}?expectedVersion=1`);
    const lapsed = await createViaApi(owner);
    await expireLink(lapsed.shareId);
    await open(owner);
    await openShare(user);
    const dialog = await screen.findByRole('dialog', { name: 'Share' });
    await waitFor(() => expect(activeRows()).toHaveLength(2));
    expect(within(dialog).getByRole('heading', { name: 'Active links' })).toBeInTheDocument();
    const [newest, oldest] = activeRows();
    expect(newest).toHaveTextContent('Not used yet');
    expect(newest).toHaveTextContent(/Expires in (23|24) hr/);
    expect(oldest).toHaveTextContent('Conversation in progress');
    expect(oldest).toHaveTextContent(/Expires in (23|24) hr/);
    expect(within(dialog).getAllByRole('button', { name: /^Revoke link created / })).toHaveLength(2);
    for (const secret of [running, fresh, revoked, lapsed]) expect(dialog.innerHTML).not.toContain(tokenOf(secret.url));
    expect(dialog.textContent).not.toMatch(/Used|Expired|Revoked/);
  });

  it('shows expiry in minutes when under an hour', async () => {
    const { expiresIn } = await import('../../src/pages/owner/format.js');
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(expiresIn('2026-09-30T12:00:00Z', now)).toBe('Expires in 24 hr');
    expect(expiresIn('2026-09-30T11:00:00Z', now)).toBe('Expires in 23 hr');
    expect(expiresIn('2026-09-29T12:40:00Z', now)).toBe('Expires in 40 min');
    expect(expiresIn('2026-09-29T11:59:00Z', now)).toBe('Expired');
  });

  it('revokes one link from its row and leaves the others', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const [one, two] = [await createViaApi(owner), await createViaApi(owner)];
    await open(owner);
    await openShare(user);
    await waitFor(() => expect(activeRows()).toHaveLength(2));
    await user.click(within(activeRows()[0]).getByRole('button', { name: /^Revoke/ }));
    await waitFor(() => expect(activeRows()).toHaveLength(1));
    expect(await statuses(owner)).toEqual(['unused', 'revoked']);
    expect(await (await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(two.url) } })).json()).toMatchObject({ reason: 'revoked' });
    expect((await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(one.url) } })).status).toBe(200);
    expect(screen.getByText('Link revoked')).toBeInTheDocument();
  });

  it('asks before revoking a link with a conversation under way, and ends that conversation', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createViaApi(owner);
    const { cookie } = await asGuest(share.url);
    const { demoId } = await (await harness.guest('/v1/shared/start', { cookie })).json();
    await workerReady(harness.pg, owner.scopeId, demoId);
    await open(owner);
    await openShare(user);
    await waitFor(() => expect(activeRows()).toHaveLength(1));
    await user.click(within(activeRows()[0]).getByRole('button', { name: /^Revoke/ }));
    expect(screen.getByText('This ends the conversation in progress.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await statuses(owner)).toEqual(['active']);
    await user.click(within(activeRows()[0]).getByRole('button', { name: /^Revoke/ }));
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(activeRows()).toHaveLength(0));
    expect(await statuses(owner)).toEqual(['revoked']);
    expect(endedLive).toEqual(expect.arrayContaining([expect.objectContaining({ demoId })]));
    expect(screen.queryByRole('heading', { name: 'Active links' })).not.toBeInTheDocument();
  });

  it('disables Create link at five unused links, says why, and enables it after one is revoked', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    for (let count = 0; count < 5; count += 1) await createViaApi(owner);
    await open(owner);
    await openShare(user);
    await waitFor(() => expect(activeRows()).toHaveLength(5));
    const button = screen.getByRole('button', { name: 'Create link' });
    expect(button).toBeDisabled();
    expect(screen.getByText('You already have 5 unused links. Revoke one to create another.')).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription('You already have 5 unused links. Revoke one to create another.');
    await user.click(within(activeRows()[0]).getByRole('button', { name: /^Revoke/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled());
    expect(screen.queryByText('You already have 5 unused links. Revoke one to create another.')).not.toBeInTheDocument();
    await createLink(user);
    expect(await statuses(owner)).toEqual(['unused', 'unused', 'unused', 'unused', 'revoked', 'unused']);
  });

  it('never shows the secret again: not in storage, titles, labels or the console, and not after it closes', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const logs = /** @type {('log' | 'info' | 'warn' | 'error' | 'debug')[]} */ (['log', 'info', 'warn', 'error', 'debug']).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    await open(owner);
    await openShare(user);
    const url = await createLink(user);
    const token = tokenOf(url);
    await waitFor(() => expect(activeRows()).toHaveLength(1));
    for (const element of Array.from(document.querySelectorAll('[title],[aria-label]'))) {
      expect(element.getAttribute('title') ?? '').not.toContain(token);
      expect(element.getAttribute('aria-label') ?? '').not.toContain(token);
    }
    expect(document.title).not.toContain(token);
    expect(window.location.href).not.toContain(token);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(token);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(token);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.innerHTML).not.toContain(token);
    const listed = await (await apiClient(owner).request('GET', `/v1/agents/${owner.agentId}/shares`)).text();
    expect(listed).not.toContain(token);
    // Open again: the earlier link is listed, still works, and its URL is not shown.
    await openShare(user);
    await waitFor(() => expect(activeRows()).toHaveLength(1));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(token);
    expect((await harness.guest('/v1/shared/exchange', { body: { token } })).status).toBe(200);
    expect(logs.flatMap((spy) => spy.mock.calls).flat().join(' ')).not.toContain(token);
  });

  it('copies the link and says so only after the clipboard accepts it', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await openShare(user);
    const url = await createLink(user);
    let accept = () => {};
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(write).toHaveBeenCalledWith(url);
    expect(screen.queryByText('Link copied')).not.toBeInTheDocument();
    accept();
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    expect(screen.getByText('Link copied')).toHaveAttribute('role', 'status');
    expect(screen.queryByText("Couldn't copy automatically. Select the link and copy it.")).not.toBeInTheDocument();
  });

  it('tells the owner to copy by hand, with the link selected, when the clipboard refuses', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await openShare(user);
    await createLink(user);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    const message = await screen.findByText("Couldn't copy automatically. Select the link and copy it.");
    expect(message).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Link copied')).not.toBeInTheDocument();
    expect(linkField()).toHaveFocus();
    expect(linkField().selectionStart).toBe(0);
    expect(linkField().selectionEnd).toBe(linkField().value.length);
  });

  it('keeps focus inside the dialog: link, Copy link, Create link, Close, Revoke, then back to the link', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await openShare(user);
    const heading = await screen.findByRole('heading', { name: 'Share' });
    await createLink(user);
    await waitFor(() => expect(activeRows()).toHaveLength(1));
    heading.focus();
    await user.tab();
    expect(document.activeElement).toBe(linkField());
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Copy link');
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Create link');
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Close');
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Revoke');
    await user.tab();
    expect(document.activeElement).toBe(linkField());
  });

  it('opens over the receptionist page at the /share address, and closing goes back to the page', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, sharePath(owner));
    expect(await screen.findByRole('dialog', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Blake' })).toBeInTheDocument();
    await createButton();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(window.location.pathname).toBe(bobPath(owner)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Blake' })).toBeInTheDocument();
    expect(await grantRows(owner)).toHaveLength(0);
  });

  it('says it could not create a link when nothing reached the server, and tries again', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await screen.findByRole('button', { name: 'More actions' });
    await openShare(user);
    await createButton();
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (init.method === 'POST' && String(input).endsWith('/shares')) throw new TypeError('Failed to fetch');
      return inner(input, init);
    };
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText("Couldn't create a link. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'New link' })).not.toBeInTheDocument();
    expect(await grantRows(owner)).toHaveLength(0);
    globalThis.fetch = inner;
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByRole('textbox', { name: 'New link' })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't create a link. Try again.")).not.toBeInTheDocument();
  });

  it('says it could not load links, and tries again, without making anything', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await screen.findByRole('button', { name: 'More actions' });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if ((init.method ?? 'GET') === 'GET' && String(input).endsWith('/shares')) throw new TypeError('Failed to fetch');
      return inner(input, init);
    };
    await openShare(user);
    expect(await screen.findByText("Couldn't load your links. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
    globalThis.fetch = inner;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await createButton();
    expect(await grantRows(owner)).toHaveLength(0);
  });

  it('asks to open Share again when the receptionist changed while the page was open', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner);
    await screen.findByRole('button', { name: 'More actions' });
    await ownerAtNewVersion(owner, '33333333-3333-4333-8333-333333333333');
    await openShare(user);
    await user.click(await createButton());
    expect(await screen.findByText('Blake was updated. Close this box and choose Share again.')).toBeInTheDocument();
    expect(await grantRows(owner)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument());
    await openShare(user);
    expect(await createLink(user)).toMatch(/#t=/);
  });

  it('says sharing is unavailable when voice is off, and offers no link', async () => {
    const owner = nextOwner();
    const withoutVoice = startServer(harness.pg, {});
    await open(owner, sharePath(owner), { app: withoutVoice });
    const dialog = await screen.findByRole('dialog', { name: 'Share' });
    expect(within(dialog).getByText("Sharing isn't available right now. Please contact the Frontline team.")).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
    expect(await grantRows(owner)).toHaveLength(0);
  });

  it('disables Share in the menu, with Talk, when voice is off', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const withoutVoice = startServer(harness.pg, {});
    await open(owner, bobPath(owner), { app: withoutVoice });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Give feedback' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Talk to Blake' })).toBeDisabled();
  });

  it("does not open Share for a receptionist that is not yours", async () => {
    const [mine, theirs] = [nextOwner(), nextOwner()];
    await open(mine, sharePath(theirs));
    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open receptionist' })).toHaveAttribute('href', '/app');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await grantRows(theirs)).toHaveLength(0);
  });

  it("does not open Share for an unfinished workspace", async () => {
    const lonely = await createUiHarness({ owners: 0 });
    try {
      const owner = await seedClaimedOwner(lonely.pg);
      await asOwner(lonely.pg, async () => {
        await lonely.pg.query("UPDATE frontline_claimed_targets SET target_kind = 'workspace' WHERE owner_scope_id = $1", [owner.scopeId]);
        await lonely.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify({ workspaces: { [owner.agentId]: { id: owner.agentId, businessName: 'Half Done' } }, agents: {}, demos: {} })]);
      });
      await open(owner, sharePath(owner), { app: lonely.app });
      expect(await screen.findByRole('heading', { level: 1, name: "Blake isn't ready yet." })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    } finally { await lonely.pg.close(); }
  });

  it('asks a signed-out visitor to sign in', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, sharePath(owner), { signedIn: false });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see your receptionist.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(window.__signIn).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the guest side untouched by owner screens: no demo is started by making a link', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const startedBefore = voice.started.length;
    await open(owner);
    await openShare(user);
    await createLink(user);
    expect(voice.started.length).toBe(startedBefore);
    expect(await demoIds(harness.pg, owner.scopeId)).toEqual([]);
    expect((await grantRows(owner))[0].status).toBe('unused');
  });
});
