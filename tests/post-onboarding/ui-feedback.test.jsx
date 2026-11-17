// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { formatDateTime } from '../../src/pages/owner/format.js';
import { asOwner, fakeVoice } from './fixtures.js';
import { at, seedConversations } from './ui-conversations-fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { failRequests } from './ui-network.js';

// Other test files run beside this one and a busy machine can make a route slower than the 1 second default.
configure({ asyncUtilTimeout: 5000 });

// PO-S4. Real handler and real migrated Postgres. Only the paid voice provider is replaced.
let harness; let browser; let injected; let nextOwner = 0;
const freshOwner = () => harness.owners[nextOwner++];
afterEach(() => { injected?.restore(); injected = null; browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ owners: 20, handlerContext: { voice: fakeVoice() } }); });

const feedbackRows = (owner) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT category, submitted_text, source, conversation_id, agent_version_id, idempotency_key FROM frontline_feedback WHERE stable_agent_id = $1 ORDER BY created_at', [owner.agentId])).rows);
const feedbackPost = (path, method) => method === 'POST' && path.endsWith('/feedback');
const draftKey = (owner) => `frontline.draft.feedback.${owner.agentId}`;

async function open(owner, { query = '', signedIn = true, signIn = () => {}, agentId = owner.agentId } = {}) {
  resetOwnerApi();
  browser = installBrowserFetch({ app: harness.app, authToken: signedIn ? owner.authToken : null });
  window.history.replaceState({}, '', `/app/agents/${agentId}/feedback${query}`);
  return render(<OwnerApp signIn={signIn} />);
}
const ready = () => screen.findByRole('heading', { level: 1, name: 'Feedback' }).then(() => screen.findByRole('textbox', { name: 'What should work better?' }));
const send = () => screen.getByRole('button', { name: 'Send to the Frontline team' });

describe('Product feedback: layout and copy', () => {
  it('shows the heading, the sentence, the topic radios, the conversation select and the text field', async () => {
    const owner = freshOwner();
    await open(owner);
    const field = await ready();
    expect(document.title).toBe('Feedback · Frontline');
    const description = screen.getByText('Tell the Frontline team how we can serve you better.');
    expect(description).toHaveClass('owner-lede');
    expect(screen.queryByText(/Correcting something about your business/)).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'What is this about?' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.closest('label').textContent)).toEqual(['How the receptionist sounded or handled the call', "Something the receptionist couldn't do", 'Something else']);
    within(group).getAllByRole('radio').forEach((radio) => expect(radio).not.toBeChecked());
    const select = screen.getByRole('combobox', { name: 'Which conversation?' });
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { name: 'Not about one conversation' })).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(screen.getByText('0 of 10,000')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    expect(document.body.textContent).not.toMatch(/phone|activate/i);
  });

  it('lists the owner\'s conversations by origin and date, and takes the topic and conversation from the link', async () => {
    const owner = freshOwner();
    const [older, newer] = await seedConversations(harness.pg, owner, [
      { mode: 'owner_test', createdAt: at(0), durationSeconds: 60 },
      { mode: 'shared_guest', createdAt: at(30), durationSeconds: 120 },
    ]);
    await open(owner, { query: `?category=functionality&conversation=${older}` });
    await ready();
    const select = screen.getByRole('combobox', { name: 'Which conversation?' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Not about one conversation', `Shared link, ${formatDateTime(at(30))}`, `Your call, ${formatDateTime(at(0))}`]);
    expect(select).toHaveValue(older);
    expect(screen.getByRole('radio', { name: "Something the receptionist couldn't do" })).toBeChecked();
    expect(within(select).getByRole('option', { name: `Shared link, ${formatDateTime(at(30))}` })).toHaveValue(newer);
  });

  it('ignores a topic in the link that is not one of the three', async () => {
    await open(freshOwner(), { query: '?category=business_context' });
    await ready();
    screen.getAllByRole('radio').forEach((radio) => expect(radio).not.toBeChecked());
  });
});

describe('Product feedback: submit and receipt', () => {
  it('sends after the server confirms and shows one receipt with a way back', async () => {
    const owner = freshOwner();
    const [conversationId] = await seedConversations(harness.pg, owner, [{ createdAt: at(5), durationSeconds: 30 }]);
    const user = userEvent.setup();
    await open(owner);
    await ready();
    await user.click(screen.getByRole('radio', { name: 'How the receptionist sounded or handled the call' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Which conversation?' }), conversationId);
    await user.click(screen.getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('Blake sounded rushed.');
    expect(screen.getByText('21 of 10,000')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey(owner))).toBe('Blake sounded rushed.');
    await user.click(send());

    const receipt = await screen.findByRole('region', { name: 'Sent to the team' });
    expect(within(receipt).getByText("Thanks. The Frontline team will read it.")).toBeInTheDocument();
    expect(within(receipt).getByText(/^Reference [0-9a-f-]{8}\. /)).toBeInTheDocument();
    expect(within(receipt).getByRole('link', { name: 'Back to receptionist' })).toHaveAttribute('href', `/app/agents/${owner.agentId}`);
    await waitFor(() => expect(within(receipt).getByRole('heading', { name: 'Sent to the team' })).toHaveFocus());
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ category: 'quality', submitted_text: 'Blake sounded rushed.', source: 'owner', conversation_id: conversationId, agent_version_id: owner.agentId })]);
    expect(window.sessionStorage.getItem(draftKey(owner))).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'What should work better?' })).not.toBeInTheDocument();
    // The receipt never promises a fix.
    expect(document.body.textContent).not.toMatch(/will be fixed|we will fix/i);
  });

  it('sends without a conversation when none is chosen', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner);
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('General thought.');
    await user.click(send());
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ category: 'other', conversation_id: null })]);
  });

  it('cannot be completed without a topic; the first invalid control takes focus and nothing is sent', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner);
    await user.click(await ready());
    await user.paste('No topic chosen.');
    await user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose what this is about.');
    expect(screen.getByRole('radio', { name: 'How the receptionist sounded or handled the call' })).toHaveFocus();
    expect(browser.calls.some((call) => feedbackPost(call.path, call.method))).toBe(false);
    expect(await feedbackRows(owner)).toEqual([]);
  });

  it('can be completed with the keyboard alone, from the first control to the receipt', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner);
    await ready();
    screen.getByRole('radio', { name: 'How the receptionist sounded or handled the call' }).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Something else' })).toBeChecked();
    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Which conversation?' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'What should work better?' })).toHaveFocus();
    await user.keyboard('Typed without a mouse.');
    await user.tab();
    expect(send()).toHaveFocus();
    await user.keyboard(' ');
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ category: 'other', submitted_text: 'Typed without a mouse.' })]);
  });
});

describe('Product feedback: limits', () => {
  it('blocks text over 10,000 characters with a message, and sends exactly 10,000', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner);
    const field = await ready();
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    fireEvent.change(field, { target: { value: 'x'.repeat(10_001) } });
    expect(screen.getByText('10,001 of 10,000')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("That's too big. Use up to 10,000 characters.");
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription("That's too big. Use up to 10,000 characters.");
    expect(send()).toBeDisabled();
    expect(browser.calls.some((call) => feedbackPost(call.path, call.method))).toBe(false);

    fireEvent.change(field, { target: { value: 'y'.repeat(10_000) } });
    expect(screen.getByText('10,000 of 10,000')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
    await user.click(send());
    await screen.findByRole('region', { name: 'Sent to the team' });
    const [row] = await feedbackRows(owner);
    expect(row.submitted_text).toHaveLength(10_000);
  });

  it('keeps Send disabled for whitespace only', async () => {
    const user = userEvent.setup();
    await open(freshOwner());
    await user.click(await ready());
    await user.paste('   \n  ');
    expect(send()).toBeDisabled();
  });
});

describe('Product feedback: failure and retry', () => {
  it('reuses the idempotency key when a rejected send is retried, and shows the exact message', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner);
    await ready();
    injected = failRequests({ match: feedbackPost, mode: 'before' });
    await user.click(screen.getByRole('radio', { name: "Something the receptionist couldn't do" }));
    await user.click(screen.getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('Could not transfer me.');
    await user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't send that. Message still in the box. Try sending again.");
    expect(screen.getByRole('textbox', { name: 'What should work better?' })).toHaveValue('Could not transfer me.');
    expect(screen.queryByRole('region', { name: 'Sent to the team' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(injected.seen.map((call) => call.failed)).toEqual([true, false]);
    expect(injected.seen[1].headers['Idempotency-Key']).toBe(injected.seen[0].headers['Idempotency-Key']);
    expect(await feedbackRows(owner)).toHaveLength(1);
  });

  it('after a lost response the retry returns the same receipt and the database keeps one row', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner);
    await ready();
    injected = failRequests({ match: feedbackPost, mode: 'after' });
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('The response never arrived.');
    await user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Frontline. Check your connection, then try again. Message still in the box.");
    // The server did store it on the first try.
    expect(await feedbackRows(owner)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    const receipt = await screen.findByRole('region', { name: 'Sent to the team' });
    expect(injected.seen[1].headers['Idempotency-Key']).toBe(injected.seen[0].headers['Idempotency-Key']);
    expect(await feedbackRows(owner)).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Sent to the team' })).toEqual([receipt]);
  });

  it('says a conversation is no longer available when the server refuses it, and keeps the text', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    await open(owner, { query: `?conversation=${randomUUID()}` });
    await ready();
    expect(screen.getByRole('combobox', { name: 'Which conversation?' })).toHaveDisplayValue('Chosen conversation');
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('About a conversation that is gone.');
    await user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent('That conversation is no longer available. Choose another, or send without one. Message still in the box.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Which conversation?' }), '');
    await user.click(send());
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ conversation_id: null })]);
  });

  it('keeps the draft and offers sign-in when the session expired, then sends after signing back in', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    const signIn = vi.fn();
    await open(owner, { signIn });
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('Written before the session ended.');
    delete browser.jar.fl_auth;
    await user.click(send());
    expect(await screen.findByText('Sign in again to send this. Message still in the box.')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey(owner))).toBe('Written before the session ended.');
    expect(screen.getByRole('textbox', { name: 'What should work better?' })).toHaveValue('Written before the session ended.');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledTimes(1);
    browser.jar.fl_auth = owner.authToken;
    await user.click(send());
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(await feedbackRows(owner)).toHaveLength(1);
  });

  it('asks a signed-out visitor to sign in and keeps their draft in storage', async () => {
    const owner = freshOwner();
    window.sessionStorage.setItem(draftKey(owner), 'Draft from before.');
    const signIn = vi.fn();
    const user = userEvent.setup();
    await open(owner, { signedIn: false, signIn });
    expect(await screen.findByText('Sign in again to continue.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'What should work better?' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(draftKey(owner))).toBe('Draft from before.');
  });

  it('says so when the agent is not this account\'s', async () => {
    await open(freshOwner(), { agentId: randomUUID() });
    expect(await screen.findByText("Couldn't find that receptionist.")).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('still lets the owner write when the conversation list cannot load, and brings the select back on retry', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    resetOwnerApi();
    browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
    injected = failRequests({ match: (path, method) => method === 'GET' && path.endsWith('/conversations'), mode: 'before' });
    window.history.replaceState({}, '', `/app/agents/${owner.agentId}/feedback`);
    render(<OwnerApp />);
    expect(await screen.findByText("Couldn't load conversations.")).toBeInTheDocument();
    expect(screen.getByText('Feedback can still be sent without choosing one.')).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'What should work better?' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Which conversation?' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('combobox', { name: 'Which conversation?' })).toBeInTheDocument();
  });
});

describe('Product feedback: draft', () => {
  it('restores an unsent draft, says so, and removes it after a confirmed send', async () => {
    const owner = freshOwner();
    window.sessionStorage.setItem(draftKey(owner), 'Unsent thought.');
    const user = userEvent.setup();
    await open(owner);
    const field = await ready();
    expect(field).toHaveValue('Unsent thought.');
    expect(screen.getByText('Unsent draft restored.')).toBeInTheDocument();
    expect(screen.getByText('15 of 10,000')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(send());
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(window.sessionStorage.getItem(draftKey(owner))).toBeNull();
    // A fresh visit starts empty.
    cleanup();
    await open(owner);
    expect(await ready()).toHaveValue('');
    expect(screen.queryByText('Unsent draft restored.')).not.toBeInTheDocument();
  });

  it('works when sessionStorage is unavailable', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      await open(owner);
      await user.click(await ready());
      await user.paste('No storage here.');
      await user.click(screen.getByRole('radio', { name: 'Something else' }));
      await user.click(send());
      await screen.findByRole('region', { name: 'Sent to the team' });
    } finally { blocked.mockRestore(); }
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ submitted_text: 'No storage here.' })]);
  });
});
