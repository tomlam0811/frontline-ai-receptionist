// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { ownerApi, resetOwnerApi } from '../../src/lib/owner-api.js';
import { DEFAULT_GUEST_CONFIG } from '../../server/api/post-onboarding/guest.js';
import { asOwner, browserClient, fakeVoice, seedClaimedOwner, startServer } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { fakeLivekit, fakeRooms } from './fake-livekit.js';
import { callerSays, demoIds, scopeState, terminalPath, workerReady } from './ui-calls.js';

// Only two things are replaced: the paid LiveKit provider on the server (fakeVoice) and the browser
// `livekit-client` Room, which needs WebRTC that jsdom lacks. The handler, database, API client and pages are real.
vi.mock('livekit-client', () => import('./fake-livekit.js'));

let harness; let browser; let voice; let nextIndex = 0;
const OWNERS = 20;
const nextOwner = () => harness.owners[nextIndex++];

beforeAll(async () => {
  voice = fakeVoice();
  let terminal;
  harness = await createUiHarness({
    owners: OWNERS,
    handlerContext: { voice, endOwnerDemo: (call) => terminal(call), guestConfig: { ...DEFAULT_GUEST_CONFIG, dailyCapCents: 100_000, reservedCents: 100, globalConcurrent: 50 } },
  });
  terminal = terminalPath(harness.pg);
  harness.terminal = terminal;
});
afterEach(() => { browser?.restore(); resetOwnerApi(); fakeLivekit.reset(); voice.failStart = false; });
afterAll(async () => { await harness?.pg.close(); });

const open = async (owner, path, { signedIn = true, app = harness.app } = {}) => {
  browser = installBrowserFetch({ app, authToken: signedIn ? owner.authToken : null });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => { window.__signIn = true; }} />);
};
const talkPath = (owner) => `/app/agents/${owner.agentId}/talk`;
const CALL = 'Call with Blake';
const startButton = () => screen.findByRole('button', { name: 'Start call' });
const connected = () => waitFor(() => expect(fakeRooms.at(-1)?.connected).toBe(true));

/** Starts a call through the page and returns the call region and the demo id. */
async function startThroughPage(user, owner, versionText = CALL) {
  await user.click(await startButton());
  const region = await screen.findByRole('region', { name: versionText });
  await connected();
  const demoId = (await demoIds(harness.pg, owner.scopeId)).at(-1);
  return { region, demoId };
}

describe('Talk to Blake screen (PO-S5)', () => {
  it('starts a call, shows the live state and the server deadline, ends it, and shows what came of it', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    expect(await screen.findByRole('heading', { level: 1, name: 'Talk to Blake' })).toBeInTheDocument();
    expect(await screen.findByText('Talk the way a customer would. Calls last up to 5 minutes.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/test/i);
    expect(screen.queryByRole('region', { name: CALL })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sign ?up|pricing plan|phone number/i);

    const { region, demoId } = await startThroughPage(user, owner);
    expect(fakeRooms.at(-1).url).toBe('wss://voice.test');
    expect(fakeRooms.at(-1).token).toMatch(/^token-/);
    expect(await within(region).findByText('Microphone on. Waiting for Blake…')).toBeInTheDocument();
    expect(fakeRooms.at(-1).microphone).toEqual([true]);
    expect((await scopeState(harness.pg, owner.scopeId)).demos[demoId]).toMatchObject({ mode: 'owner_test', state: 'waiting', agentVersionId: owner.agentId });

    await workerReady(harness.pg, owner.scopeId, demoId);
    expect(await within(region).findByText(/^\d:\d\d remaining$/, {}, { timeout: 6000 })).toBeInTheDocument();
    await act(async () => { await fakeRooms.at(-1).caption('bob-agent', 'Riverside Dental, how can I help?'); await fakeRooms.at(-1).caption('visitor-local', 'I need a teeth cleaning next week', 's2'); });
    expect(within(region).getByText('Riverside Dental, how can I help?')).toBeInTheDocument();
    expect(within(region).getByText('You')).toBeInTheDocument();
    await callerSays(harness.pg, owner.scopeId, demoId, 'I need a teeth cleaning next Tuesday morning please');

    await user.click(within(region).getByRole('button', { name: 'End call' }));
    const finished = await screen.findByRole('heading', { name: 'Call ended' });
    expect(finished).toHaveFocus();
    expect(screen.queryByRole('region', { name: CALL })).not.toBeInTheDocument();
    expect(fakeRooms.at(-1).disconnects).toBeGreaterThan(0);
    expect(within(screen.getByRole('region', { name: 'Call result' })).getByText(/teeth cleaning next Tuesday/)).toBeInTheDocument();
    expect(screen.queryByText(/mark as reviewed|Tested|didn't count/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Talk again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all conversations' })).toHaveAttribute('href', `/app/agents/${owner.agentId}/conversations`);
    expect(screen.getByRole('link', { name: 'Send feedback' })).toHaveAttribute('href', `/app/agents/${owner.agentId}/feedback?conversation=${demoId}`);
    expect(screen.getByRole('link', { name: 'Back to Blake' })).toHaveAttribute('href', `/app/agents/${owner.agentId}`);
    // The server still records that the latest version was heard on a call.
    expect((await scopeState(harness.pg, owner.scopeId)).agentLineages[owner.agentId].revisions[0].lastTestedAt).toBeTruthy();
    const paths = browser.calls.map((call) => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/g, ':id')}`);
    expect(paths).toEqual(expect.arrayContaining(['POST /v1/agents/:id/tests', 'POST /v1/agents/:id/tests/:id/end', 'GET /v1/agents/:id/tests/:id/result']));
  });

  it('starts the call on arrival from Talk to Blake, with no second button to press', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, `/app/agents/${owner.agentId}`);
    const talk = await screen.findByRole('link', { name: 'Talk to Blake' });
    expect(talk).toHaveAttribute('href', talkPath(owner));
    await user.click(talk);
    expect(await screen.findByRole('region', { name: CALL })).toBeInTheDocument();
    await connected();
    expect(screen.queryByRole('button', { name: 'Start call' })).not.toBeInTheDocument();
    // The arrival flag is used once, so a reload of this address does not start another call.
    expect(window.history.state?.startCall).toBeUndefined();
  });

  it('opens the same screen from the old /test address', async () => {
    const owner = nextOwner();
    await open(owner, `/app/agents/${owner.agentId}/test`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Talk to Blake' })).toBeInTheDocument();
  });

  it('says Blake heard nothing when the owner said nothing', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    const { region } = await startThroughPage(user, owner);
    await user.click(within(region).getByRole('button', { name: 'End call' }));
    expect(await screen.findByRole('heading', { name: 'Call ended' })).toBeInTheDocument();
    expect(screen.getByText("Blake didn't hear anything on this call.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Talk again' })).toBeInTheDocument();
    expect((await scopeState(harness.pg, owner.scopeId)).agentLineages?.[owner.agentId]?.revisions[0].lastTestedAt ?? null).toBeNull();
  });

  it('shows the finished state by itself when the server ends the call (time limit)', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    const { demoId } = await startThroughPage(user, owner);
    await workerReady(harness.pg, owner.scopeId, demoId);
    await callerSays(harness.pg, owner.scopeId, demoId, 'Do you do emergency fillings on weekends');
    await harness.terminal({ scopeId: owner.scopeId, demoId });
    expect(await screen.findByRole('heading', { name: 'Call ended' }, { timeout: 6000 })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Call result' })).getByText(/emergency fillings/)).toBeInTheDocument();
  });

  it('says the daily limit is reached after three calls, with no way to retry', async () => {
    const owner = nextOwner();
    const client = browserClient(harness.app, owner.authToken);
    for (let count = 0; count < 3; count += 1) {
      const response = await client.request('POST', `/v1/agents/${owner.agentId}/tests`, { body: { expectedAgentVersionId: owner.agentId } });
      expect(response.status).toBe(201);
      await harness.terminal({ scopeId: owner.scopeId, demoId: (await response.json()).demoId });
    }
    const startedBefore = voice.started.length;
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    await user.click(await startButton());
    expect(await screen.findByText("You've used today's 3 test calls. The limit resets at midnight Pacific time.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start call' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: CALL })).not.toBeInTheDocument();
    expect(voice.started.length).toBe(startedBefore);
    expect(document.body.textContent).not.toMatch(/voice_limit_reached/);
  });

  it('clears the exhausted state after Pacific midnight without reloading the Talk page', async () => {
    const owner = nextOwner();
    const client = browserClient(harness.app, owner.authToken);
    for (let count = 0; count < 3; count += 1) {
      const response = await client.request('POST', `/v1/agents/${owner.agentId}/tests`, { body: { expectedAgentVersionId: owner.agentId } });
      expect(response.status).toBe(201);
      await harness.terminal({ scopeId: owner.scopeId, demoId: (await response.json()).demoId });
    }
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    await user.click(await startButton());
    expect(await screen.findByText("You've used today's 3 test calls. The limit resets at midnight Pacific time.")).toBeInTheDocument();

    const RealDate = globalThis.Date;
    const blockedDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate());
    let mockedNow = RealDate.now();
    do { mockedNow += 30 * 60_000; } while (new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(mockedNow)) === blockedDay);
    class ShiftedDate extends RealDate {
      constructor(value) { super(value ?? mockedNow); }
      static now() { return mockedNow; }
    }
    try {
      vi.stubGlobal('Date', ShiftedDate);
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      expect(screen.queryByText("You've used today's 3 test calls. The limit resets at midnight Pacific time.")).not.toBeInTheDocument();
      expect(await startButton()).toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not show yesterday’s limit when a rejected start responds after Pacific midnight', async () => {
    const owner = nextOwner();
    await open(owner, talkPath(owner));
    const button = await startButton();

    const RealDate = globalThis.Date;
    const formatPacificDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
    const blockedDay = formatPacificDay(new RealDate());
    let nextDay = RealDate.now();
    do { nextDay += 60_000; } while (formatPacificDay(new RealDate(nextDay)) === blockedDay);
    let mockedNow = nextDay - 60_000;
    class ShiftedDate extends RealDate {
      constructor(value) { super(value ?? mockedNow); }
      static now() { return mockedNow; }
    }
    let responseArrived;
    const arrived = new Promise((resolve) => { responseArrived = resolve; });
    const responseControl = { release: () => {} };
    const responseGate = new Promise((resolve) => { responseControl.release = () => resolve(); });
    const startSpy = vi.spyOn(ownerApi, 'startTest').mockImplementation(async () => {
      responseArrived();
      await responseGate;
      throw Object.assign(new Error('test limit reached'), { code: 'test_limit_reached', status: 429 });
    });
    try {
      vi.stubGlobal('Date', ShiftedDate);
      button.click();
      await arrived;
      mockedNow = nextDay;
      await act(async () => { responseControl.release(); });
      await waitFor(() => expect(screen.queryByText("You've used today's 3 test calls. The limit resets at midnight Pacific time.")).not.toBeInTheDocument());
      expect(await startButton()).toBeInTheDocument();
    } finally {
      responseControl.release();
      startSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('says another call is in progress, then lets the owner try again once it ends', async () => {
    const owner = nextOwner();
    const client = browserClient(harness.app, owner.authToken);
    const busy = await client.request('POST', `/v1/agents/${owner.agentId}/tests`, { body: { expectedAgentVersionId: owner.agentId } });
    const busyDemo = (await busy.json()).demoId;
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    await user.click(await startButton());
    expect(await screen.findByText('Another call with Blake is in progress. Try again in a few minutes.')).toBeInTheDocument();
    await harness.terminal({ scopeId: owner.scopeId, demoId: busyDemo });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: CALL })).toBeInTheDocument();
    await connected();
  });

  it('says the call could not start when the voice provider fails, counts nothing, and allows a retry', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    voice.failStart = true;
    await open(owner, talkPath(owner));
    await user.click(await startButton());
    expect(await screen.findByText("Couldn't start the call.")).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/provider|livekit|cannot delete/i);
    const state = await scopeState(harness.pg, owner.scopeId);
    expect(Object.values(state.demos).map((demo) => demo.state)).toEqual(['failed']);
    expect(state.agentLineages?.[owner.agentId]?.revisions[0].lastTestedAt ?? null).toBeNull();
    voice.failStart = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: CALL })).toBeInTheDocument();
  });

  it('asks to reload when Blake changed while the page was open, then calls the new version', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    await startButton();
    const newVersion = '11111111-1111-4111-8111-111111111111';
    await asOwner(harness.pg, async () => {
      const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state;
      state.agents[newVersion] = { ...state.agents[owner.agentId], id: newVersion };
      const revision = (agentVersionId, parent, kind) => ({ agentVersionId, knowledgeRevisionId: state.agents[owner.agentId].knowledgeRevisionId, parentAgentVersionId: parent, kind, createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null });
      state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, pointerGeneration: 2, currentAgentVersionId: newVersion, revisions: [revision(owner.agentId, null, 'initial'), revision(newVersion, owner.agentId, 'knowledge')] } };
      await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
    });
    const startedBefore = voice.started.length;
    await user.click(screen.getByRole('button', { name: 'Start call' }));
    expect(await screen.findByText('Blake was updated while this page was open. Reload to talk to the latest version.')).toBeInTheDocument();
    expect(voice.started.length).toBe(startedBefore);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Talk the way a customer would. Calls last up to 5 minutes.')).toBeInTheDocument();
    expect(screen.queryByText('Blake was updated while this page was open. Reload to talk to the latest version.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start call' }));
    expect(await screen.findByRole('region', { name: CALL })).toBeInTheDocument();
    expect((await scopeState(harness.pg, owner.scopeId)).demos[(await demoIds(harness.pg, owner.scopeId)).at(-1)].agentVersionId).toBe(newVersion);
  });

  it('explains a blocked microphone and recovers when it is allowed', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    fakeLivekit.microphoneError = 'NotAllowedError';
    await open(owner, talkPath(owner));
    const { region } = await startThroughPage(user, owner);
    expect(await within(region).findByText('The browser blocked the microphone. Allow it in the address bar or browser settings, then try again.')).toBeInTheDocument();
    expect(within(region).getByText('Connected. The microphone is off.')).toBeInTheDocument();
    fakeLivekit.microphoneError = null;
    await user.click(within(region).getByRole('button', { name: 'Try microphone again' }));
    expect(await within(region).findByText('Microphone on. Waiting for Blake…')).toBeInTheDocument();
  });

  it('says when the voice room could not connect and joins on retry', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    fakeLivekit.failConnect = true;
    await open(owner, talkPath(owner));
    await user.click(await startButton());
    const region = await screen.findByRole('region', { name: CALL });
    expect(await within(region).findByText("Couldn't connect the call. Check your connection, then try again.")).toBeInTheDocument();
    fakeLivekit.failConnect = false;
    await user.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(await within(region).findByText('Microphone on. Waiting for Blake…')).toBeInTheDocument();
  });

  it('is fully operable from the keyboard and labels its regions and status', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, talkPath(owner));
    await startButton();
    const heading = screen.getByRole('heading', { level: 1, name: 'Talk to Blake' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.title).toBe('Talk to Blake · Frontline');
    expect(screen.getByRole('main')).toBeInTheDocument();
    const tabTo = async (name, limit = 12) => {
      for (let step = 0; step < limit; step += 1) {
        await user.tab();
        if (document.activeElement?.textContent === name) return document.activeElement;
      }
      throw new Error(`could not reach ${name} by keyboard`);
    };
    /** @type {HTMLElement} */ (document.activeElement)?.blur();
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Skip to main content');
    await tabTo('Start call');
    await user.keyboard('{Enter}');
    const region = await screen.findByRole('region', { name: CALL });
    expect(within(region).getByRole('status')).toHaveTextContent(/Connecting|Microphone/);
    expect(within(region).getByRole('heading', { name: 'Captions' })).toBeInTheDocument();
    await within(region).findByText('Microphone on. Waiting for Blake…');
    await tabTo('End call', 20);
    await user.keyboard(' ');
    expect(await screen.findByRole('heading', { name: 'Call ended' })).toHaveFocus();
  });

  it('shows Blake cannot take a call while voice is unavailable, and offers no start', async () => {
    const owner = nextOwner();
    const withoutVoice = startServer(harness.pg, {});
    await open(owner, talkPath(owner), { app: withoutVoice });
    expect(await screen.findByText("Blake can't take a call yet.")).toBeInTheDocument();
    expect(screen.getByText("Calls aren't available right now. Please contact the Frontline team.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start call' })).not.toBeInTheDocument();
  });

  it('asks a signed-out visitor to sign in', async () => {
    const owner = nextOwner();
    const user = userEvent.setup();
    await open(owner, talkPath(owner), { signedIn: false });
    expect(await screen.findByText('Sign in to talk to your receptionist.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(window.__signIn).toBe(true);
    expect(screen.queryByRole('button', { name: 'Start call' })).not.toBeInTheDocument();
  });

  it("never starts a call for someone else's Blake, and says the agent could not be found", async () => {
    const [mine, theirs] = [nextOwner(), nextOwner()];
    const startedBefore = voice.started.length;
    await open(mine, talkPath(theirs));
    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open receptionist' })).toHaveAttribute('href', '/app');
    expect(screen.queryByText("Blake can't take a call yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start call' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Riverside Dental');
    expect(voice.started.length).toBe(startedBefore);
  });

  it("says Blake can't take a call yet for an unfinished workspace, distinct from a missing agent", async () => {
    const lonely = await createUiHarness({ owners: 0 });
    try {
      const owner = await seedClaimedOwner(lonely.pg);
      await asOwner(lonely.pg, async () => {
        await lonely.pg.query("UPDATE frontline_claimed_targets SET target_kind = 'workspace' WHERE owner_scope_id = $1", [owner.scopeId]);
        await lonely.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify({ workspaces: { [owner.agentId]: { id: owner.agentId, businessName: 'Half Done' } }, agents: {}, demos: {} })]);
      });
      await open(owner, talkPath(owner), { app: lonely.app });
      expect(await screen.findByText("Blake can't take a call yet.")).toBeInTheDocument();
      expect(screen.getByText('Add your business details to get Blake ready.')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Start call' })).not.toBeInTheDocument();
    } finally { await lonely.pg.close(); }
  });
});
