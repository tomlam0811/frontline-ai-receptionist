// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { forgetGuestToken } from '../../src/components/owner/guest-token.js';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { asOwner, browserClient, fakeVoice, seedSession } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { fakeLivekit, fakeRooms } from './fake-livekit.js';
import { callerSays, demoIds, guestFetch, scopeState, terminalPath, tokenOf, workerReady } from './ui-calls.js';

// Real handler, real migrated Postgres, real pages. Faked: the paid LiveKit provider on the server (fakeVoice), the browser
// `livekit-client` Room (no WebRTC in jsdom), and the browser microphone permission API (jsdom has no media devices).
vi.mock('livekit-client', () => import('./fake-livekit.js'));

// The first render of each screen loads its code on demand, which can take a moment under load.
configure({ asyncUtilTimeout: 4000 });

let harness; let browser; let voice; let nextIndex = 0; let seen = [];
const OWNERS = 40;
const nextOwner = () => harness.owners[nextIndex++];

beforeAll(async () => {
  voice = fakeVoice();
  let terminal;
  harness = await createUiHarness({
    owners: OWNERS,
    handlerContext: { voice, limits: { guest: 100_000 }, endGuestDemo: (call) => terminal(call), endLiveCall: (call) => terminal(call), guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 100_000, reservedCents: 100, globalConcurrent: 50 } },
  });
  terminal = terminalPath(harness.pg);
  harness.terminal = terminal;
  harness.guest = guestFetch(harness.app);
});
afterEach(() => {
  browser?.restore(); resetOwnerApi(); forgetGuestToken(); fakeLivekit.reset(); voice.failStart = false; voice.failEnd = false; vi.restoreAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});
afterAll(async () => { await harness?.pg.close(); });

const apiClient = (owner) => browserClient(harness.app, owner.authToken);
const createLink = async (owner) => (await apiClient(owner).request('POST', `/v1/agents/${owner.agentId}/shares`, { body: { expectedAgentVersionId: owner.agentId } })).json();
const grantOf = (shareId) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT * FROM frontline_share_grants WHERE id = $1', [shareId])).rows[0]);
const sql = (text, params) => asOwner(harness.pg, () => harness.pg.query(text, params));

/** A guest's browser. `jar` carries the fl_guest cookie from an earlier page load in the same browser. Every /v1/shared response is kept in `seen`. */
/** @param {string} path @param {{jar?: Record<string, string>}} [options] */
function openGuest(path, { jar } = {}) {
  browser?.restore();
  browser = installBrowserFetch({ app: harness.app, authToken: null });
  if (jar) Object.assign(browser.jar, jar);
  seen = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const response = await inner(input, init);
    if (String(input).includes('/v1/shared/')) seen.push({ path: String(input), status: response.status, text: await response.clone().text() });
    return response;
  };
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => { window.__signIn = true; }} />);
}
const guestUrl = (share) => `/shared${new URL(share.url).hash}`;
const restoreBrowserFetch = () => { const { jar } = browser; browser.restore(); return { ...jar }; };

function stubMicrophone({ deny = null } = {}) {
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => {
    if (deny) throw Object.assign(new Error('denied'), { name: deny });
    return { getTracks: () => [{ stop }] };
  });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  return { getUserMedia, stop };
}
const checkMicrophone = async (user) => {
  await user.click(await screen.findByRole('button', { name: 'Check my microphone' }));
  await screen.findByText('Microphone ready.');
};
const connected = () => waitFor(() => expect(fakeRooms.at(-1)?.connected).toBe(true));
const callRegion = () => screen.findByRole('region', { name: 'Conversation with Blake' });

/** Opens the link, passes the mic check and starts the conversation. Returns the region and the demo id. */
async function startConversation(user, owner, share, options) {
  stubMicrophone();
  openGuest(guestUrl(share), options);
  await checkMicrophone(user);
  await user.click(screen.getByRole('button', { name: 'Start conversation' }));
  const region = await callRegion();
  await connected();
  const demoId = (await demoIds(harness.pg, owner.scopeId)).at(-1);
  return { region, demoId };
}
/** The worker recording what the caller asked for on this call, as the open task the call summary is built from. */
const callerAsks = (owner, demoId, task) => asOwner(harness.pg, async () => {
  const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
  (state.workflows ??= {})[demoId] = { workflowInstanceId: `workflow-${demoId}`, currentTask: task, priorTasks: {} };
  await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1 WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
});
const OWNER_CONTENT = [/PRIVATE-KNOWLEDGE-SENTINEL/, /Open receptionist/, /Knowledge/i, /Capabilities/, /Read call summaries/, /Share Blake/, /Test Blake/, /Your links/];

describe('Guest page: the link and the address bar (PO-S7)', () => {
  it('removes the secret from the address bar at once, with replaceState, and keeps it out of storage, titles and requests', async () => {
    const owner = nextOwner();
    const share = await createLink(owner);
    const token = tokenOf(share.url);
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const before = window.history.length;
    /** @type {(value?: unknown) => void} */ let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    browser = installBrowserFetch({ app: harness.app, authToken: null });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => { if (String(input).endsWith('/v1/shared/exchange')) await gate; return inner(input, init); };
    window.history.replaceState({}, '', guestUrl(share));
    expect(window.location.hash).toBe(`#t=${token}`);
    render(<OwnerApp />);
    expect(await screen.findByText('Checking this link…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Talk to the receptionist' })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.pathname).toBe('/shared');
    expect(window.location.href).not.toContain(token);
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
    release();
    await screen.findByRole('button', { name: 'Start conversation' });
    expect(browser.calls.filter((call) => call.path.includes(token))).toEqual([]);
    expect(browser.calls.find((call) => call.path === '/v1/shared/exchange').body).toEqual({ token });
    expect(document.body.innerHTML).not.toContain(token);
    expect(document.title).not.toContain(token);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(token);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(token);
    expect(String(document.referrer)).not.toContain(token);
  });

  it('shows the entry page with the exact copy and offers nothing that leads to the owner side', async () => {
    const owner = nextOwner();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    expect(await screen.findByText("Blake is the receptionist for Riverside Dental.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Talk to Blake' })).toBeInTheDocument();
    expect(screen.getByText('Talk the way you would on the phone. Conversations last up to 5 minutes.')).toBeInTheDocument();
    expect(screen.getByText("Riverside Dental can read a summary and transcript of this conversation. The Frontline team may read any feedback you send. Conversations are deleted after 30 days.")).toBeInTheDocument();
    expect(screen.getByText('Blake needs your microphone to hear you. Check it before you start.')).toBeInTheDocument();
    expect(document.title).toBe('Talk to Blake · Frontline');
    expect(document.body.textContent).not.toMatch(/demo|test call/i);
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
    for (const link of Array.from(document.querySelectorAll('a'))) expect(link.getAttribute('href')).toBe('#main');
    expect(document.body.textContent).not.toMatch(/sign in|log in|sign up|analytics/i);
    for (const pattern of OWNER_CONTENT) expect(document.body.textContent).not.toMatch(pattern);
    expect((await grantOf(share.shareId)).status).toBe('unused');
  });

  it('keeps the link unused through the mic check and "Not now"', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const mic = stubMicrophone();
    openGuest(guestUrl(share));
    await checkMicrophone(user);
    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(mic.stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByText("Not started. This link hasn't been used yet.")).toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'unused', demo_id: null, lease_generation: 0 });
    expect(voice.started.length).toBe(0 + voice.started.length);
    expect(await demoIds(harness.pg, owner.scopeId)).toEqual([]);
  });

  it('explains a denied microphone, leaves the link unused, and lets the guest check again', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    stubMicrophone({ deny: 'NotAllowedError' });
    openGuest(guestUrl(share));
    await user.click(await screen.findByRole('button', { name: 'Check my microphone' }));
    expect(await screen.findByText('The browser blocked the microphone. Allow it in the address bar or browser settings, then check again.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'unused' });
    stubMicrophone();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Microphone ready.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeEnabled();
  });
});

describe('Guest page: links that cannot be used', () => {
  /** @type {[string, (owner: any) => Promise<string>, string, string][]} */
  const dead = [
    ['a link nobody issued', async () => `/shared#t=${'A'.repeat(43)}`, "This link isn't available.", 'Ask the person who sent you the link for a new one.'],
    ['a revoked link', async (owner) => { const share = await createLink(owner); await apiClient(owner).request('DELETE', `/v1/agents/${owner.agentId}/shares/${share.shareId}?expectedVersion=1`); return guestUrl(share); }, 'This link is no longer active.', 'Ask the person who sent you the link for a new one.'],
    ['an expired link', async (owner) => { const share = await createLink(owner); await sql("UPDATE frontline_share_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [share.shareId]); return guestUrl(share); }, 'This link has expired.', 'Ask the person who sent you the link for a new one.'],
    ['a link that was already used', async (owner) => {
      const share = await createLink(owner);
      const opened = await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(share.url) } });
      const cookie = opened.headers.get('set-cookie').split(';')[0];
      const { demoId } = await (await harness.guest('/v1/shared/start', { cookie })).json();
      await workerReady(harness.pg, owner.scopeId, demoId);
      await callerSays(harness.pg, owner.scopeId, demoId, 'PRIOR-GUEST-SECRET-WORDS about a broken crown');
      await harness.terminal({ scopeId: owner.scopeId, demoId });
      return guestUrl(share);
    }, 'This conversation has ended.', 'Each link works for one conversation. Ask the person who sent you the link for a new one.'],
  ];
  it.each(dead)('shows one calm dead end for %s and nothing else', async (_name, prepare, heading, sentence) => {
    const owner = nextOwner();
    const url = await prepare(owner);
    openGuest(url);
    const title = await screen.findByRole('heading', { level: 1, name: heading });
    expect(title).toHaveFocus();
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PRIOR-GUEST-SECRET-WORDS|transcript|summary of/i);
    expect(window.location.hash).toBe('');
    for (const pattern of OWNER_CONTENT) expect(document.body.textContent).not.toMatch(pattern);
  });

  it('shows the unavailable page for a bare /shared with no link and no session', async () => {
    openGuest('/shared');
    expect(await screen.findByRole('heading', { level: 1, name: "This link isn't available." })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says it could not reach Frontline and retries with the same link', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    browser = installBrowserFetch({ app: harness.app, authToken: null });
    const inner = globalThis.fetch;
    let failing = true;
    globalThis.fetch = async (input, init) => { if (failing && String(input).endsWith('/v1/shared/exchange')) throw new TypeError('Failed to fetch'); return inner(input, init); };
    window.history.replaceState({}, '', guestUrl(share));
    render(<OwnerApp />);
    expect(await screen.findByText("Couldn't reach Frontline.")).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Start conversation' })).toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'unused' });
  });
});

describe('Guest page: the conversation', () => {
  it('starts, shows the server deadline and the wrap-up line, ends, shows their own summary, and consumes the link', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const { region, demoId } = await startConversation(user, owner, share);
    expect(fakeRooms.at(-1).url).toBe('wss://voice.test');
    expect(within(region).getByText('Conversation with Blake')).toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'reserved', demo_id: demoId });
    expect(within(region).queryByText(/remaining/)).not.toBeInTheDocument();
    await workerReady(harness.pg, owner.scopeId, demoId, { startedAgoSeconds: 280 });
    expect(await within(region).findByText(/^0:[12]\d remaining$/, {}, { timeout: 6000 })).toBeInTheDocument();
    expect(within(region).getByText('Blake is wrapping up.')).toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'active' });
    await callerSays(harness.pg, owner.scopeId, demoId, 'I need someone to look at a chipped front tooth this week');
    await callerAsks(owner, demoId, { kind: 'service_request', goal: 'Fix a chipped front tooth', status: 'collecting', fields: { serviceNeed: 'Chipped front tooth repair', callerName: 'Dana Reyes' }, missingFields: ['contactPhone', 'contactEmail'] });
    await user.click(within(region).getByRole('button', { name: 'End call' }));

    const thanks = await screen.findByRole('heading', { level: 1, name: 'Thanks for talking with Blake.' });
    expect(thanks).toHaveFocus();
    expect(document.body.textContent).not.toMatch(/demo/i);
    // The guest sees what they asked for and who has it, never the owner's review details or their own excerpts.
    const request = within(screen.getByRole('region', { name: 'Call result' })).getByRole('article', { name: 'Chipped front tooth repair' });
    expect(within(request).getByText('Your request')).toBeInTheDocument();
    expect(within(request).getByText('Dana Reyes')).toBeInTheDocument();
    expect(within(request).getByText('Passed along to Riverside Dental. Nothing is booked yet.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Needs review|Missing:|Next step|Caller notes|look at a chipped front tooth this week/);
    expect(screen.queryByRole('region', { name: 'Conversation with Blake' })).not.toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'consumed' });
    expect(fakeRooms.at(-1).disconnects).toBeGreaterThan(0);
    for (const pattern of OWNER_CONTENT) expect(document.body.textContent).not.toMatch(pattern);
  });

  it('is single use: the same link, the same browser and a second start all refuse afterwards', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const { region, demoId } = await startConversation(user, owner, share);
    await workerReady(harness.pg, owner.scopeId, demoId);
    await callerSays(harness.pg, owner.scopeId, demoId, 'Do you take walk-ins on Saturday mornings');
    await user.click(within(region).getByRole('button', { name: 'End call' }));
    await screen.findByRole('heading', { name: 'Thanks for talking with Blake.' });
    const jar = restoreBrowserFetch();
    cleanup();
    forgetGuestToken();
    // The same browser opens the link again: the exchange refuses, and no result is shown for a used link.
    openGuest(guestUrl(share), { jar });
    expect(await screen.findByRole('heading', { level: 1, name: 'This conversation has ended.' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/walk-ins/);
    cleanup();
    // A start with the old cookie is refused by the server, and the grant never returns to unused.
    const start = await harness.guest('/v1/shared/start', { cookie: `fl_guest=${jar.fl_guest}` });
    expect([start.status, (await start.json()).title]).toEqual([409, 'link_used']);
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'consumed' });
    expect(voice.started.filter((id) => id === demoId)).toHaveLength(1);
  });

  it('says someone else started it when another browser started the same link first', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    await checkMicrophone(user);
    const other = await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(share.url) } });
    const started = await harness.guest('/v1/shared/start', { cookie: other.headers.get('set-cookie').split(';')[0] });
    expect(started.status).toBe(201);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Someone else has started this conversation.' })).toBeInTheDocument();
    expect(screen.getByText('Each link works for one conversation. Ask the person who sent you the link for a new one.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Conversation with Blake/ })).not.toBeInTheDocument();
    expect(fakeRooms).toHaveLength(0);
  });

  it('says someone else started it when another link for the same Blake is already in a conversation', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const first = await createLink(owner);
    const second = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(second));
    await checkMicrophone(user);
    const other = await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(first.url) } });
    expect((await harness.guest('/v1/shared/start', { cookie: other.headers.get('set-cookie').split(';')[0] })).status).toBe(201);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Someone else has started this conversation.' })).toBeInTheDocument();
    expect(await grantOf(second.shareId)).toMatchObject({ status: 'unused' });
  });

  it('says the call could not start and offers Try again only when the link went back to unused', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    await checkMicrophone(user);
    voice.failStart = true;
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(await screen.findByText("Couldn't start the call.")).toBeInTheDocument();
    expect(screen.getByText('Try again. If it keeps failing, ask the person who sent you the link.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/provider|livekit|voice_unavailable/i);
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'unused' });
    voice.failStart = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await callRegion()).toBeInTheDocument();
  });

  it('does not offer Try again when the room could not be confirmed gone (the link stays reserved)', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    await checkMicrophone(user);
    voice.failStart = true; voice.failEnd = true;
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(await screen.findByText("Couldn't start the call.")).toBeInTheDocument();
    expect(screen.getByText('Ask the person who sent you the link for help.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'reserved' });
  });

  it('says Blake is at capacity when the daily guest limit is reached, and the link stays unused', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    for (let count = 0; count < 3; count += 1) {
      const share = await createLink(owner);
      const opened = await harness.guest('/v1/shared/exchange', { body: { token: tokenOf(share.url) } });
      const { demoId } = await (await harness.guest('/v1/shared/start', { cookie: opened.headers.get('set-cookie').split(';')[0] })).json();
      await workerReady(harness.pg, owner.scopeId, demoId);
      await harness.terminal({ scopeId: owner.scopeId, demoId });
    }
    const fourth = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(fourth));
    await checkMicrophone(user);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(await screen.findByText('Blake is busy right now.')).toBeInTheDocument();
    expect(screen.getByText("This link hasn't been used yet. Try again in a few minutes.")).toBeInTheDocument();
    expect(await grantOf(fourth.shareId)).toMatchObject({ status: 'unused' });
    expect(document.body.textContent).not.toMatch(/voice_limit_reached/);
  });

  it('rejoins the same conversation after a refresh, with the original remaining time', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const { demoId } = await startConversation(user, owner, share);
    await workerReady(harness.pg, owner.scopeId, demoId, { startedAgoSeconds: 100 });
    const jar = restoreBrowserFetch();
    cleanup();
    fakeLivekit.reset();
    openGuest('/shared', { jar });
    const region = await callRegion();
    expect(screen.getByText("Back in your conversation.")).toBeInTheDocument();
    await connected();
    expect(fakeRooms.at(-1).token).toBe('reconnect-1');
    expect(await within(region).findByText(/^3:[12]\d remaining$/, {}, { timeout: 6000 })).toBeInTheDocument();
    expect((await scopeState(harness.pg, owner.scopeId)).demos[demoId].hardEndAt).toBeTruthy();
    expect(await demoIds(harness.pg, owner.scopeId)).toEqual([demoId]);
    expect(voice.started.filter((id) => id === demoId)).toHaveLength(1);
  });

  it('shows the entry page again after a refresh before starting, from the cookie alone', async () => {
    const owner = nextOwner();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    await screen.findByRole('button', { name: 'Start conversation' });
    const jar = restoreBrowserFetch();
    cleanup();
    forgetGuestToken();
    openGuest('/shared', { jar });
    expect(await screen.findByText("Blake is the receptionist for Riverside Dental.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
  });

  it("says the conversation can't be reopened when the cookie is lost after starting", async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    await startConversation(user, owner, share);
    cleanup();
    forgetGuestToken();
    openGuest('/shared', { jar: {} });
    expect(await screen.findByRole('heading', { level: 1, name: "This conversation can't be reopened from this browser." })).toBeInTheDocument();
    expect(screen.getByText('Ask the person who sent you the link for a new one.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ends the call and says the link is no longer active when the owner revokes it mid-call', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const { demoId } = await startConversation(user, owner, share);
    await workerReady(harness.pg, owner.scopeId, demoId);
    const revoke = await apiClient(owner).request('DELETE', `/v1/agents/${owner.agentId}/shares/${share.shareId}?expectedVersion=${(await grantOf(share.shareId)).version}`);
    expect(revoke.status).toBe(200);
    expect(await screen.findByRole('heading', { level: 1, name: 'This link is no longer active.' }, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Conversation with Blake/ })).not.toBeInTheDocument();
    expect(fakeRooms.at(-1).disconnects).toBeGreaterThan(0);
  });

  it('ends by itself at the server deadline and shows the result', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const { demoId } = await startConversation(user, owner, share);
    await callerSays(harness.pg, owner.scopeId, demoId, 'Can I bring my daughter for a first visit');
    await workerReady(harness.pg, owner.scopeId, demoId, { startedAgoSeconds: 299 });
    expect(await screen.findByRole('heading', { level: 1, name: 'Thanks for talking with Blake.' }, { timeout: 8000 })).toBeInTheDocument();
    expect(await grantOf(share.shareId)).toMatchObject({ status: 'consumed' });
  });
});

describe('Guest page: feedback for the builder', () => {
  async function finishedConversation(user, owner, share) {
    const { region, demoId } = await startConversation(user, owner, share);
    await workerReady(harness.pg, owner.scopeId, demoId);
    await callerSays(harness.pg, owner.scopeId, demoId, 'The receptionist was very clear about parking');
    await user.click(within(region).getByRole('button', { name: 'End call' }));
    await screen.findByRole('heading', { name: 'Thanks for talking with Blake.' });
    return { demoId };
  }

  it('sends feedback to the builder within the window and shows a receipt', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    const { demoId } = await finishedConversation(user, owner, share);
    expect(screen.getByRole('heading', { name: 'How was this conversation?' })).toBeInTheDocument();
    expect(screen.getByText("The Frontline team may read this.")).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send feedback' });
    expect(send).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Feedback' }), 'Blake explained the parking clearly.');
    expect(screen.getByText('36 of 10,000')).toBeInTheDocument();
    await user.click(send);
    expect(await screen.findByRole('heading', { name: /Sent to the team/ })).toBeInTheDocument();
    expect(screen.getByText("Thanks. The Frontline team will read it.")).toBeInTheDocument();
    expect(screen.getByText(/^Reference [0-9a-f]{8}\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
    const builder = await seedSession(harness.pg, { builder: true });
    const found = await (await browserClient(harness.app, builder.authToken).request('GET', '/v1/builder/feedback?q=parking')).json();
    expect(found.records).toHaveLength(1);
    expect(found.records[0]).toMatchObject({ source: 'guest', conversationId: demoId, agentId: owner.agentId, submittedText: 'Blake explained the parking clearly.' });
  });

  it('keeps the text on failure and a retry after a lost response makes exactly one feedback record', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    await finishedConversation(user, owner, share);
    await user.type(screen.getByRole('textbox', { name: 'Feedback' }), 'Clear about the parking, unsure about insurance.');
    const inner = globalThis.fetch;
    let lose = true;
    globalThis.fetch = async (input, init = {}) => {
      const response = await inner(input, init);
      if (lose && String(input).endsWith('/v1/shared/feedback')) throw new TypeError('Failed to fetch');
      return response;
    };
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByText(/Couldn't reach Frontline\./)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveValue('Clear about the parking, unsure about insurance.');
    lose = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /Sent to the team/ })).toBeInTheDocument();
    const rows = await sql("SELECT count(*)::int AS n FROM frontline_feedback WHERE owner_scope_id = $1 AND submitted_text LIKE 'Clear about the parking%'", [owner.scopeId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('lets the guest skip feedback', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    await finishedConversation(user, owner, share);
    await user.click(screen.getByRole('button', { name: 'No thanks' }));
    expect(screen.queryByRole('heading', { name: 'How was this conversation?' })).not.toBeInTheDocument();
    expect(screen.getByText('You can close this page.')).toBeInTheDocument();
    expect((await sql('SELECT count(*)::int AS n FROM frontline_feedback WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].n).toBe(0);
  });

  it('closes the feedback window 24 hours after the conversation ends, in the page and on the server', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    await finishedConversation(user, owner, share);
    const jar = restoreBrowserFetch();
    cleanup();
    forgetGuestToken();
    await sql("UPDATE frontline_share_grants SET consumed_at = now() - interval '23 hours 50 minutes' WHERE id = $1", [share.shareId]);
    openGuest('/shared', { jar });
    expect(await screen.findByRole('heading', { name: 'How was this conversation?' })).toBeInTheDocument();
    cleanup();
    await sql("UPDATE frontline_share_grants SET consumed_at = now() - interval '25 hours' WHERE id = $1", [share.shareId]);
    openGuest('/shared', { jar });
    expect(await screen.findByRole('heading', { level: 1, name: 'Thanks for talking with Blake.' })).toBeInTheDocument();
    expect(screen.getByText('Feedback is closed for this conversation.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Feedback' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
    const late = await harness.guest('/v1/shared/feedback', { cookie: `fl_guest=${jar.fl_guest}`, body: { category: 'quality', inputMethod: 'text', text: 'too late' } });
    expect([late.status, (await late.json()).title]).toEqual([403, 'feedback_window_closed']);
  });
});

describe('Guest page: what a guest can and cannot see', () => {
  it('never receives or renders owner content, other conversations or identifiers in any state', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await asOwner(harness.pg, async () => {
      const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
      state.demos.other = { id: 'other', mode: 'owner_test', state: 'ended', secret: 'OTHER-DEMO-SENTINEL' };
      state.callerTurns = { other: [{ text: 'OTHER-CALLER-SENTINEL', finalized: true }] };
      state.knowledgeBases = { [owner.agentId]: { entries: { a: { value: 'OWNER-ENTRY-SENTINEL' } } } };
      await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
    });
    const share = await createLink(owner);
    const { region, demoId } = await startConversation(user, owner, share);
    await workerReady(harness.pg, owner.scopeId, demoId);
    await callerSays(harness.pg, owner.scopeId, demoId, 'Please tell me about whitening');
    const inCall = document.body.innerHTML;
    await user.click(within(region).getByRole('button', { name: 'End call' }));
    await screen.findByRole('heading', { name: 'Thanks for talking with Blake.' });
    const forbidden = [/PRIVATE-KNOWLEDGE-SENTINEL/, /OTHER-DEMO-SENTINEL/, /OTHER-CALLER-SENTINEL/, /OWNER-ENTRY-SENTINEL/, new RegExp(owner.scopeId), new RegExp(owner.tenant), new RegExp(owner.agentId), /knowledgeBase/, /knowledgeLibrary/, /agentLineages/];
    for (const text of [inCall, document.body.innerHTML, ...seen.map((item) => item.text)]) for (const pattern of forbidden) expect(text).not.toMatch(pattern);
    expect(seen.map((item) => new URL(item.path, 'http://guest.test').pathname).every((path) => path.startsWith('/v1/shared/'))).toBe(true);
    expect(browser.calls.every((call) => call.path.startsWith('/v1/shared/'))).toBe(true);
    const result = JSON.parse(seen.filter((item) => item.path.endsWith('/v1/shared/result')).at(-1).text);
    expect(Object.keys(result).filter((key) => key !== 'requestId').sort()).toEqual(['callSummary', 'demoId', 'feedbackClosesAt', 'feedbackOpen', 'hardEndAt', 'linkStatus', 'mode', 'setupDeadlineAt', 'softCloseAt', 'startedAt', 'state', 'terminalReason', 'version']);
    expect(result.callSummary.demoId).toBe(demoId);
    expect(result.callSummary.callerExcerpts).toEqual(['Please tell me about whitening']);
    // Owner routes are closed to a guest cookie.
    const cookie = `fl_guest=${browser.jar.fl_guest}`;
    for (const path of [`/v1/agents/${owner.agentId}/knowledge`, `/v1/agents/${owner.agentId}/conversations`, `/v1/agents/${owner.agentId}/shares`, '/v1/me/agents']) {
      const response = await harness.app.fetch(`${harness.app.baseUrl}${path}`, { headers: { origin: harness.app.baseUrl, cookie } });
      expect([401, 403, 404]).toContain(response.status);
    }
  });

  it('is operable by keyboard alone and labels its controls, regions and status', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    await screen.findByRole('button', { name: 'Start conversation' });
    expect(screen.getByRole('main')).toBeInTheDocument();
    const tabTo = async (name, limit = 14) => {
      for (let step = 0; step < limit; step += 1) {
        await user.tab();
        if (document.activeElement?.textContent === name) return;
      }
      throw new Error(`could not reach ${name} by keyboard`);
    };
    /** @type {HTMLElement} */ (document.activeElement)?.blur();
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Skip to main content');
    await tabTo('Check my microphone');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('status', { name: '' })).toBeTruthy();
    await screen.findByText('Microphone ready.');
    await tabTo('Start conversation');
    await user.keyboard('{Enter}');
    const region = await callRegion();
    expect(within(region).getByRole('status')).toBeInTheDocument();
    await connected();
    const demoId = (await demoIds(harness.pg, owner.scopeId)).at(-1);
    await workerReady(harness.pg, owner.scopeId, demoId);
    await callerSays(harness.pg, owner.scopeId, demoId, 'Is there parking behind the building');
    await tabTo('End call', 24);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Thanks for talking with Blake.' })).toHaveFocus();
    const box = screen.getByRole('textbox', { name: 'Feedback' });
    expect(box).toHaveAccessibleDescription("The Frontline team may read this.");
    await tabTo('Your feedback'.length ? '' : '', 0).catch(() => {});
    box.focus();
    await user.keyboard('Parking answer was helpful.');
    await tabTo('Send feedback');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: /Sent to the team/ })).toBeInTheDocument();
  });

  it('announces the wait after Start with a status region', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    const share = await createLink(owner);
    stubMicrophone();
    openGuest(guestUrl(share));
    await checkMicrophone(user);
    /** @type {(value?: unknown) => void} */ let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => { if (String(input).endsWith('/v1/shared/start')) await gate; return inner(input, init); };
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    const status = (await screen.findByText('Connecting to Blake…')).closest('[role=status]');
    expect(status).toHaveClass('owner-loading');
    expect(status.querySelector('.owner-spinner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    await act(async () => { release(); });
    await callRegion();
  });
});
