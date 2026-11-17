// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { versionText } from '../../src/components/owner/ConversationRow.jsx';
import { ownerApi, resetOwnerApi } from '../../src/lib/owner-api.js';
import { formatDateTime } from '../../src/pages/owner/format.js';
import { fakeVoice } from './fixtures.js';
import { at, seedConversations } from './ui-conversations-fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { failRequests } from './ui-network.js';

// Other test files run beside this one and a busy machine can make a route slower than the 1 second default.
configure({ asyncUtilTimeout: 5000 });

// PO-S10. Real handler and real migrated Postgres. Conversations come from the real start endpoint and from
// the records the voice worker leaves behind (the backend tests write the same fixtures). Only the voice provider is replaced.
let harness; let browser; let injected; let nextOwner = 0;
const freshOwner = () => harness.owners[nextOwner++];
afterEach(() => { injected?.restore(); injected = null; browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });
// The recap model is replaced too: it writes a recap only for calls that mention Fridays, so other calls show the fallback.
const writeRecap = async (transcript) => (transcript.some((entry) => entry.text.includes('Fridays')) ? 'The caller asked about Friday hours and a cracked tooth. Blake gave the hours and offered to help.' : null);
beforeAll(async () => { harness = await createUiHarness({ owners: 24, handlerContext: { voice: fakeVoice(), writeRecap } }); });

async function open(owner, path = '', { signedIn = true, signIn = () => {}, agentId = owner.agentId } = {}) {
  resetOwnerApi();
  browser = installBrowserFetch({ app: harness.app, authToken: signedIn ? owner.authToken : null });
  window.history.replaceState({}, '', `/app/agents/${agentId}/conversations${path}`);
  return render(<OwnerApp signIn={signIn} />);
}
const listHeading = () => screen.findByRole('heading', { level: 1, name: 'Conversations' });
const rows = () => within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem');

describe('Conversation list', () => {
  it('shows a loading state while the list loads', async () => {
    const owner = freshOwner();
    /** @type {{release: (value?: any) => void}} */
    const gate = { release: () => {} };
    resetOwnerApi();
    browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
    const inner = globalThis.fetch;
    const held = new Promise((resolve) => { gate.release = resolve; });
    globalThis.fetch = async (input, init) => { if (/\/conversations(\?|$)/.test(String(input))) await held; return inner(input, init); };
    try {
      window.history.replaceState({}, '', `/app/agents/${owner.agentId}/conversations`);
      render(<OwnerApp />);
      expect((await screen.findByText('Loading conversations…')).closest('[role=status]')).toHaveClass('owner-loading');
      gate.release();
      expect(await screen.findByRole('heading', { level: 2, name: 'No conversations yet.' })).toBeInTheDocument();
    } finally { globalThis.fetch = inner; }
  });

  it('shows the heading and the retention line, with no section links', async () => {
    const owner = freshOwner();
    await open(owner);
    await listHeading();
    expect(document.title).toBe('Conversations · Frontline');
    expect(screen.getByText('Conversations are kept for 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Receptionist sections' })).not.toBeInTheDocument();
    const back = screen.getByRole('link', { name: 'Back to Blake' });
    expect(back).toHaveAttribute('href', `/app/agents/${owner.agentId}`);
    expect(back).toHaveAttribute('title', 'Back to Blake');
    expect(back.querySelector('svg')).toBeInTheDocument();
    expect(back).toHaveTextContent('');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('says there is nothing yet and offers the two ways to make a conversation', async () => {
    const owner = freshOwner();
    await open(owner);
    expect(await screen.findByRole('heading', { level: 2, name: 'No conversations yet.' })).toBeInTheDocument();
    expect(screen.getByText('Your calls with Blake and calls from shared links appear here.')).toBeInTheDocument();
    const talk = screen.getByRole('link', { name: 'Talk to Blake' });
    expect(talk).toHaveAttribute('href', `/app/agents/${owner.agentId}/talk`);
    // Talk to Blake starts the call on arrival: the link carries that in history state. The navigation is held back.
    const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
    await userEvent.click(talk);
    expect(push).toHaveBeenCalledWith({ startCall: true }, '', `/app/agents/${owner.agentId}/talk`);
    push.mockRestore();
    expect(screen.queryByRole('link', { name: /^Share/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    const create = await within(dialog).findByRole('button', { name: 'Create link' });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(await within(dialog).findByRole('textbox', { name: 'New link' })).toHaveAttribute('readonly');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('lists conversations newest first with origin, date, duration, status and version, and includes a call started through the real endpoint', async () => {
    const owner = freshOwner();
    await seedConversations(harness.pg, owner, [
      { mode: 'business_demo', createdAt: at(0), durationSeconds: 45 },
      { mode: 'owner_test', createdAt: at(5), durationSeconds: 61, terminalReason: 'caller_ended' },
      { mode: 'owner_test', createdAt: at(10), durationSeconds: 134 },
      { mode: 'shared_guest', createdAt: at(20), durationSeconds: 300, state: 'failed' },
      { mode: 'owner_test', createdAt: at(30), durationSeconds: 20, terminalReason: 'caller_ended',
        currentTask: { kind: 'service_request', status: 'stopped', noteRecordId: 'n1', fields: { serviceNeed: 'Driveway washing' } } },
    ]);
    resetOwnerApi();
    browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
    const started = await ownerApi.startTest(owner.agentId, owner.agentId);
    window.history.replaceState({}, '', `/app/agents/${owner.agentId}/conversations`);
    render(<OwnerApp />);
    await listHeading();
    const items = await waitFor(() => { const found = rows(); expect(found).toHaveLength(6); return found; });
    expect(items.map((item) => item.querySelector('strong').textContent)).toEqual(['Your call', 'Your call', 'Shared link', 'Your call', 'Your call', 'Your call']);
    // The call that is still running has no end yet.
    expect(items[0]).toHaveTextContent('In progress');
    expect(items[0]).not.toHaveTextContent('latest changes');
    expect(items[0].querySelector('a')).toHaveAttribute('href', `/app/agents/${owner.agentId}/conversations/${started.demoId}`);
    // The caller hung up with a request unfinished: "Ended early", not "Complete" or "Interrupted".
    expect(items[1]).toHaveTextContent('Ended early');
    // The same ending with nothing left open is a normal close, for example Blake's own goodbye after saving the request.
    expect(items[4]).toHaveTextContent('1 min 1 sec');
    expect(items[4]).toHaveTextContent('Complete');
    expect(items[2]).toHaveTextContent(formatDateTime(at(20)));
    expect(items[2]).toHaveTextContent('5 min 0 sec');
    expect(items[2]).toHaveTextContent('Interrupted');
    expect(items[3]).toHaveTextContent('2 min 14 sec');
    expect(items[3]).toHaveTextContent('Complete');
    expect(items[5]).toHaveTextContent('45 sec');
    // Status is text with an icon, not color alone.
    expect(within(items[3]).getByText('Complete').closest('.owner-chip').querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('hides another owner\'s conversations', async () => {
    const mine = freshOwner(); const other = freshOwner();
    await seedConversations(harness.pg, mine, [{ createdAt: at(1), durationSeconds: 10 }]);
    await open(other);
    expect(await screen.findByRole('heading', { level: 2, name: 'No conversations yet.' })).toBeInTheDocument();
  });

  it('pages 25 at a time with Load more, without duplicates, and moves focus to the first new row', async () => {
    const owner = freshOwner();
    await seedConversations(harness.pg, owner, Array.from({ length: 30 }, (_, index) => ({ mode: 'owner_test', createdAt: at(index), durationSeconds: 60 })));
    const user = userEvent.setup();
    await open(owner);
    await listHeading();
    await waitFor(() => expect(rows()).toHaveLength(25));
    const before = rows().map((item) => item.querySelector('a').getAttribute('href'));
    expect(within(rows()[0]).getByText(formatDateTime(at(29)))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(30));
    const after = rows().map((item) => item.querySelector('a').getAttribute('href'));
    expect(after.slice(0, 25)).toEqual(before);
    expect(new Set(after).size).toBe(30);
    expect(within(rows()[29]).getByText(formatDateTime(at(0)))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(rows()[25].querySelector('a')).toHaveFocus();
  });

  it('keeps the rows and offers the same button again when loading more fails', async () => {
    const owner = freshOwner();
    await seedConversations(harness.pg, owner, Array.from({ length: 27 }, (_, index) => ({ mode: 'owner_test', createdAt: at(index), durationSeconds: 30 })));
    const user = userEvent.setup();
    await open(owner);
    await waitFor(() => expect(rows()).toHaveLength(25));
    injected = failRequests({ match: (path, method, search) => method === 'GET' && path.endsWith('/conversations') && search.includes('cursor='), mode: 'before' });
    screen.getByRole('button', { name: 'Load more' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText("Couldn't load more. Try again.")).toBeInTheDocument();
    expect(rows()).toHaveLength(25);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(27));
    expect(screen.queryByText("Couldn't load more. Try again.")).not.toBeInTheDocument();
  });

  it('shows a loading message while more rows load', async () => {
    const owner = freshOwner();
    await seedConversations(harness.pg, owner, Array.from({ length: 26 }, (_, index) => ({ createdAt: at(index), durationSeconds: 5 })));
    const user = userEvent.setup();
    await open(owner);
    await waitFor(() => expect(rows()).toHaveLength(25));
    const inner = globalThis.fetch;
    /** @type {(value?: any) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (input, init) => { if (String(input).includes('cursor=')) await gate; return inner(input, init); };
    try {
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Loading more…');
      expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
      release();
      await waitFor(() => expect(rows()).toHaveLength(26));
      expect(screen.queryByText('Loading more…')).not.toBeInTheDocument();
    } finally { globalThis.fetch = inner; }
  });

  it('fails softly and retries', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    resetOwnerApi();
    browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
    window.history.replaceState({}, '', `/app/agents/${owner.agentId}/conversations`);
    // Let the agent summary through and fail only the list.
    injected = failRequests({ match: (path, method) => method === 'GET' && path.endsWith('/conversations'), mode: 'before' });
    render(<OwnerApp />);
    expect(await screen.findByText("Couldn't load conversations.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'No conversations yet.' })).toBeInTheDocument();
  });

  it('asks a signed-out visitor to sign in', async () => {
    const signIn = vi.fn();
    const user = userEvent.setup();
    await open(freshOwner(), '', { signedIn: false, signIn });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see your receptionist.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalled();
  });

  it('says so when the agent is not this account\'s', async () => {
    await open(freshOwner(), '', { agentId: randomUUID() });
    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).toBeInTheDocument();
  });

  it('opens a conversation from its row with the keyboard', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{ createdAt: at(3), durationSeconds: 75, callerTurns: [{ text: 'Do you take walk-ins?' }] }]);
    const user = userEvent.setup();
    await open(owner);
    await waitFor(() => expect(rows()).toHaveLength(1));
    rows()[0].querySelector('a').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: `Your call, ${formatDateTime(at(3))}` })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/app/agents/${owner.agentId}/conversations/${id}`);
  });
});

describe('Conversation detail', () => {
  it('shows the summary, outcomes and a two-sided transcript with a cut-off reply, and links back and to feedback', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{
      mode: 'owner_test', createdAt: at(0), durationSeconds: 134,
      callerTurns: [{ text: 'What time do you close on Fridays?' }, { text: 'And do you fix cracked <b>teeth</b>?' }],
      bobTurns: [{ text: 'We close at five on Fridays.' }, { text: 'Yes, we can help with cracked teeth. Our hours are', interrupted: true }],
      currentTask: { kind: 'service_request', goal: 'Book a cleaning', status: 'collecting', fields: { serviceNeed: 'Teeth cleaning' }, missingFields: [] },
      requests: [{ recordId: 'r1', fields: { serviceNeed: 'Teeth cleaning', callerName: 'Dana' }, savedAt: at(5) }],
      cases: [{ recordId: 'c1', kind: 'complaint', context: { summary: 'Waited too long' }, savedAt: at(6) }],
    }]);
    const user = userEvent.setup();
    await open(owner, `/${id}`);
    expect(await screen.findByRole('heading', { level: 1, name: `Your call, ${formatDateTime(at(0))}` })).toBeInTheDocument();
    expect(document.title).toBe('Conversation · Frontline');
    const meta = screen.getByText('2 min 14 sec').parentElement;
    expect(meta).toHaveTextContent('Complete');
    expect(meta).toHaveTextContent('Used the latest changes');

    // The written recap leads, in place of the raw caller notes.
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(summary).toHaveTextContent('The caller asked about Friday hours and a cracked tooth. Blake gave the hours and offered to help.');
    expect(screen.queryByText('Caller notes')).not.toBeInTheDocument();

    const outcomes = screen.getByRole('region', { name: 'Outcomes' });
    const request = within(outcomes).getByRole('article', { name: 'Teeth cleaning' });
    expect(request).toHaveTextContent('Needs review');
    expect(within(request).getByText('Dana')).toBeInTheDocument();
    expect(within(request).getByText('Nothing was booked or sent.')).toBeInTheDocument();
    const complaint = within(outcomes).getByRole('article', { name: 'Waited too long' });
    expect(complaint).toHaveTextContent('Needs review');
    expect(within(complaint).getByText('Nothing was booked or sent.')).toBeInTheDocument();
    expect(within(outcomes).getAllByRole('button', { name: 'Mark as done' })).toHaveLength(2);
    expect(outcomes).not.toHaveTextContent(/Request saved|Complaint saved|Saved for you to review/);

    const transcript = screen.getByRole('region', { name: 'Transcript' });
    const turns = within(transcript).getAllByRole('listitem');
    expect(turns.map((turn) => [turn.querySelector('b').textContent, turn.querySelector('p').textContent])).toEqual([
      ['Caller', 'What time do you close on Fridays?'],
      ['Blake', 'We close at five on Fridays.'],
      ['Caller', 'And do you fix cracked <b>teeth</b>?'],
      ['Blake', 'Yes, we can help with cracked teeth. Our hours are (cut off)'],
    ]);
    // Text is shown as typed, never as markup.
    expect(transcript.querySelector('p b')).toBeNull();
    expect(within(transcript).queryByText(/wasn't recorded|is missing/)).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Give feedback about this conversation' })).toHaveAttribute('href', `/app/agents/${owner.agentId}/feedback?conversation=${id}`);
    await user.click(screen.getByRole('link', { name: 'Back to conversations' }));
    await listHeading();
    expect(window.location.pathname).toBe(`/app/agents/${owner.agentId}/conversations`);
  });

  it('goes from the list to a detail page and on to the feedback screen with the conversation chosen', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{ createdAt: at(2), durationSeconds: 20, callerTurns: [{ text: 'Hello, is anyone there?' }] }]);
    const user = userEvent.setup();
    await open(owner);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(rows()[0]).getByRole('link'));
    await screen.findByRole('heading', { level: 1, name: `Your call, ${formatDateTime(at(2))}` });
    await user.click(screen.getByRole('link', { name: 'Give feedback about this conversation' }));
    await screen.findByRole('heading', { level: 1, name: 'Feedback' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Which conversation?' })).toHaveValue(id));
  });

  it('says Blake\'s side was not recorded when only the caller is stored, and labels a shared caller as Guest', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{ mode: 'shared_guest', createdAt: at(0), durationSeconds: 50, callerTurns: [{ text: 'I need a cleaning' }, { text: 'next week.' }] }]);
    await open(owner, `/${id}`);
    await screen.findByRole('heading', { level: 1, name: `Shared link, ${formatDateTime(at(0))}` });
    const transcript = screen.getByRole('region', { name: 'Transcript' });
    expect(within(transcript).getByText("Blake's side of this conversation wasn't recorded.")).toBeInTheDocument();
    const turns = within(transcript).getAllByRole('listitem');
    // Speech recognition split one sentence in two. It reads as one message.
    expect(turns).toHaveLength(1);
    expect(turns[0].querySelector('b').textContent).toBe('Guest');
    expect(turns[0].querySelector('p').textContent).toBe('I need a cleaning next week.');
    expect(within(transcript).queryByText('Blake')).not.toBeInTheDocument();
    // Without a recap, the summary falls back to the caller's own notes.
    expect(screen.getByText('Caller notes')).toBeInTheDocument();
  });

  it('says part of the conversation is missing when the transcript hit its cap', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{
      createdAt: at(0), durationSeconds: 100, callerTurns: [{ text: 'Long call, many turns here.' }],
      bobTurns: Array.from({ length: 200 }, (_, index) => ({ text: `Reply ${index + 1}` })),
    }]);
    await open(owner, `/${id}`);
    await screen.findByRole('heading', { level: 1, name: /^Your call/ });
    const transcript = screen.getByRole('region', { name: 'Transcript' });
    expect(within(transcript).getByText('Part of this conversation is missing. Only what was recorded is shown.')).toBeInTheDocument();
    expect(within(transcript).queryByText("Blake's side of this conversation wasn't recorded.")).not.toBeInTheDocument();
    // The caller's turn, then Blake's 200 back-to-back replies as one message.
    expect(within(transcript).getAllByRole('listitem')).toHaveLength(2);
  });

  it('says there is not enough to summarize as an honest state, not an error', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{ createdAt: at(0), durationSeconds: 3 }]);
    await open(owner, `/${id}`);
    await screen.findByRole('heading', { level: 1, name: /^Your call/ });
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getByText("There isn't enough in this conversation to summarize.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('No transcript for this conversation.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Outcomes' })).not.toBeInTheDocument();
  });

  it('shows one "no longer available" state for an expired, unknown or another owner\'s conversation', async () => {
    const owner = freshOwner(); const other = freshOwner();
    const [expired] = await seedConversations(harness.pg, owner, [{ createdAt: at(0), durationSeconds: 3, expiresAt: '2020-01-01T00:00:00.000Z' }]);
    const [foreign] = await seedConversations(harness.pg, other, [{ createdAt: at(0), durationSeconds: 3 }]);
    for (const id of [expired, randomUUID(), foreign]) {
      await open(owner, `/${id}`);
      expect(await screen.findByRole('heading', { level: 1, name: 'This conversation is no longer available.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to conversations' })).toHaveAttribute('href', `/app/agents/${owner.agentId}/conversations`);
      expect(document.body.textContent).not.toMatch(/expired|another owner|not found/i);
      expect(screen.queryByRole('region', { name: 'Transcript' })).not.toBeInTheDocument();
      browser.restore(); document.body.innerHTML = '';
    }
    // The expired one is not in the list either.
    await open(owner);
    expect(await screen.findByRole('heading', { level: 2, name: 'No conversations yet.' })).toBeInTheDocument();
  });

  it('shows a retry when the conversation cannot be loaded, and loads it on the second try', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{ createdAt: at(0), durationSeconds: 8, callerTurns: [{ text: 'A sentence to keep.' }] }]);
    const user = userEvent.setup();
    resetOwnerApi();
    browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
    injected = failRequests({ match: (path, method) => method === 'GET' && path.endsWith(`/conversations/${id}`), mode: 'before' });
    window.history.replaceState({}, '', `/app/agents/${owner.agentId}/conversations/${id}`);
    render(<OwnerApp />);
    expect(await screen.findByText("Couldn't load this conversation.")).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /^Your call/ })).toBeInTheDocument();
    expect(screen.getByText('A sentence to keep.')).toBeInTheDocument();
  });

  it('writes nothing until the owner marks a note done', async () => {
    const owner = freshOwner();
    const [id] = await seedConversations(harness.pg, owner, [{ createdAt: at(0), durationSeconds: 8, callerTurns: [{ text: 'Only reading here.' }] }]);
    await open(owner, `/${id}`);
    await screen.findByRole('heading', { level: 1, name: /^Your call/ });
    expect(browser.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});

describe('Version text', () => {
  it('says whether the call used current information once the current version is known', () => {
    const item = { versionLabel: 'Version 2', agentVersionId: 'a' };
    expect(versionText(item, 'a')).toBe('Used the latest changes');
    expect(versionText(item, 'b')).toBe('Before later changes');
    expect(versionText(item, null)).toBe('');
    expect(versionText({ versionLabel: null, agentVersionId: null }, 'a')).toBe('');
  });
});
