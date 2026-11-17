// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import Welcome from '../../src/pages/owner/Welcome.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { asOwner, seedClaimedOwner } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { failRequests } from './ui-network.js';

// Other test files run beside this one and a busy machine can make a route slower than the 1 second default.
configure({ asyncUtilTimeout: 5000 });

// PO-S1. Real handler, real migrated Postgres, real fetch path. Only the text extractor is replaced.
const extracted = [];
const extraction = { available: /** @type {Record<string, boolean>} */ ({ text: true }), extract: async (input) => { extracted.push(input); return { proposed: [] }; } };
let harness; let browser; let injected; let nextOwner = 0;
const freshOwner = () => harness.owners[nextOwner++];
afterEach(() => { injected?.restore(); injected = null; browser?.restore(); resetOwnerApi(); extraction.available = { text: true }; });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ owners: 20, handlerContext: { extraction } }); });

const scopeState = (owner) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state);
const feedbackRows = (owner) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT category, submitted_text, source, input_method, idempotency_key FROM frontline_feedback WHERE stable_agent_id = $1 ORDER BY created_at', [owner.agentId])).rows);
const feedbackPost = (path, method) => method === 'POST' && path.endsWith('/feedback');

function show(owner, { signedIn = true, signIn = () => {}, agentId = owner.agentId } = {}) {
  resetOwnerApi();
  browser = installBrowserFetch({ app: harness.app, authToken: signedIn ? owner.authToken : null });
  return render(<Welcome agentId={agentId} signIn={signIn} />);
}
const cardA = () => screen.getByRole('region', { name: 'Correct what Blake knows' });
const cardB = () => screen.getByRole('region', { name: 'Tell the Frontline team' });
const writeB = async (user, text, category = "Something the receptionist couldn't do") => {
  await user.click(within(cardB()).getByRole('radio', { name: category }));
  await user.click(within(cardB()).getByRole('textbox', { name: 'What should work better?' }));
  await user.paste(text);
};

describe('First saved visit: layout and copy', () => {
  it('shows the intro, both cards, the footer and labelled controls', async () => {
    show(freshOwner());
    expect(await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' })).toBeInTheDocument();
    expect(screen.getByText('Tell us what worked, what felt off, or what was missing.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(within(cardA()).getByText("Something missing or wrong about your business? Add it here. You review every change before Blake uses it. The Frontline team can also see this message.")).toBeInTheDocument();
    expect(within(cardB()).getByText("How Blake sounded, what felt off, or something Blake couldn't do. This goes to the Frontline team.")).toBeInTheDocument();
    expect(within(cardA()).getByRole('textbox', { name: 'What should Blake know or correct?' })).toBeInTheDocument();
    expect(within(cardB()).getByRole('group', { name: 'What is this about?' })).toBeInTheDocument();
    expect(within(cardB()).getAllByRole('radio').map((radio) => radio.closest('label').textContent)).toEqual(['How the receptionist sounded or handled the call', "Something the receptionist couldn't do", 'Something else']);
    expect(within(cardB()).getByRole('textbox', { name: 'What should work better?' })).toBeInTheDocument();
    expect(within(cardA()).getByRole('button', { name: 'Review changes' })).toBeDisabled();
    expect(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to Blake' })).toHaveAttribute('href', '/app');
    expect(document.body.textContent).not.toMatch(/phone|activate/i);
  });

  it('is mounted at /app/agents/:id/welcome by the router', async () => {
    const owner = freshOwner();
    resetOwnerApi();
    browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
    window.history.replaceState({}, '', `/app/agents/${owner.agentId}/welcome`);
    render(<OwnerApp />);
    expect(await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' })).toBeInTheDocument();
    expect(document.title).toBe('Welcome · Frontline');
  });

  it('shows the opening state, then moves focus to the heading', async () => {
    show(freshOwner());
    expect(screen.getByRole('heading', { level: 1, name: 'Opening your receptionist…' })).toBeInTheDocument();
    const heading = await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe('First visit: skip and continue persist', () => {
  it('records a skip without a rating, goes home, and never shows the screen again', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    const call = browser.calls.find((item) => item.path.endsWith('/first-visit'));
    expect(call).toMatchObject({ method: 'POST', body: { outcome: 'skipped' } });
    const record = (await scopeState(owner)).firstVisit[owner.agentId];
    expect(record.outcome).toBe('skipped');
    expect(Object.keys(record).sort()).toEqual(['at', 'outcome']);
    expect(await feedbackRows(owner)).toEqual([]);

    // A second visit goes to Blake's page instead of showing the first-visit screen.
    cleanup(); browser.restore(); window.history.replaceState({}, '', `/app/agents/${owner.agentId}/welcome`);
    show(owner);
    await waitFor(() => expect(window.location.pathname).toBe(`/app/agents/${owner.agentId}`));
    expect(screen.queryByRole('heading', { name: 'How was the conversation with Blake?' })).not.toBeInTheDocument();
  });

  it('records a continue', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await user.click(await screen.findByRole('link', { name: 'Continue to Blake' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect(browser.calls.find((item) => item.path.endsWith('/first-visit')).body).toEqual({ outcome: 'continued' });
    expect((await scopeState(owner)).firstVisit[owner.agentId].outcome).toBe('continued');
  });

  it('stays on the screen and offers another try when the choice could not be saved', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    injected = failRequests({ match: (path) => path.endsWith('/first-visit'), mode: 'before' });
    window.history.replaceState({}, '', '/welcome-stay');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText("Couldn't save that choice.")).toBeInTheDocument();
    expect(window.location.pathname).toBe('/welcome-stay');
    expect((await scopeState(owner)).firstVisit?.[owner.agentId]).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect((await scopeState(owner)).firstVisit[owner.agentId].outcome).toBe('skipped');
  });
});

describe('Card B: tell the builder', () => {
  it('sends after the server confirms, shows a receipt, and leaves Card A untouched', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    await user.click(within(cardA()).getByRole('textbox', { name: 'What should Blake know or correct?' }));
    await user.paste('We also fix crowns.');
    await writeB(user, 'Blake talked over me twice.', 'How the receptionist sounded or handled the call');
    expect(window.sessionStorage.getItem(`frontline.draft.feedback.${owner.agentId}.welcome`)).toBe('Blake talked over me twice.');
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));

    const receipt = await screen.findByRole('region', { name: 'Sent to the team' });
    expect(within(receipt).getByText("Thanks. The Frontline team will read it.")).toBeInTheDocument();
    const rows = await feedbackRows(owner);
    expect(rows).toEqual([expect.objectContaining({ category: 'quality', submitted_text: 'Blake talked over me twice.', source: 'owner', input_method: 'text' })]);
    expect(within(receipt).getByText(/^Reference [0-9a-f-]{8}\./)).toBeInTheDocument();
    await waitFor(() => expect(within(receipt).getByRole('heading', { name: 'Sent to the team' })).toHaveFocus());
    expect(window.sessionStorage.getItem(`frontline.draft.feedback.${owner.agentId}.welcome`)).toBeNull();
    // Card A is independent: its text is still there and nothing was sent for it.
    expect(within(cardA()).getByRole('textbox', { name: 'What should Blake know or correct?' })).toHaveValue('We also fix crowns.');
    expect(window.location.pathname).not.toMatch(/knowledge/);

    await user.click(within(receipt).getByRole('button', { name: 'Send another message' }));
    expect(within(cardB()).getByRole('textbox', { name: 'What should work better?' })).toHaveValue('');
  });

  it('asks for the topic first, focuses it, and sends nothing', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    await user.click(within(cardB()).getByRole('textbox', { name: 'What should work better?' }));
    await user.paste('It was slow.');
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));
    expect(await within(cardB()).findByRole('alert')).toHaveTextContent('Choose what this is about.');
    const first = within(cardB()).getByRole('radio', { name: 'How the receptionist sounded or handled the call' });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(browser.calls.some((call) => feedbackPost(call.path, call.method))).toBe(false);
    await user.click(within(cardB()).getByRole('radio', { name: 'Something else' }));
    expect(within(cardB()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('can be completed with the keyboard alone', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    within(cardB()).getByRole('radio', { name: 'How the receptionist sounded or handled the call' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(within(cardB()).getByRole('radio', { name: "Something the receptionist couldn't do" })).toBeChecked();
    await user.tab();
    expect(within(cardB()).getByRole('textbox', { name: 'What should work better?' })).toHaveFocus();
    await user.keyboard('The transfer question got no answer');
    await user.tab();
    expect(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ category: 'functionality', submitted_text: 'The transfer question got no answer' })]);
  });

  it('keeps the same idempotency key when a lost response is retried, and shows one receipt', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    injected = failRequests({ match: feedbackPost, mode: 'after' });
    await writeB(user, 'Lost in transit.');
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));
    expect(await within(cardB()).findByText("Couldn't reach Frontline. Check your connection, then try again. Message still in the box.")).toBeInTheDocument();
    expect(within(cardB()).getByRole('textbox', { name: 'What should work better?' })).toHaveValue('Lost in transit.');
    expect(screen.queryByRole('region', { name: 'Sent to the team' })).not.toBeInTheDocument();
    await user.click(within(cardB()).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(injected.seen).toHaveLength(2);
    expect(injected.seen[1].headers['Idempotency-Key']).toBe(injected.seen[0].headers['Idempotency-Key']);
    const rows = await feedbackRows(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(injected.seen[0].headers['Idempotency-Key']);
    expect(screen.getAllByRole('region', { name: 'Sent to the team' })).toHaveLength(1);
  });

  it('uses a new key when the text was edited after a failure', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    injected = failRequests({ match: feedbackPost, mode: 'before' });
    await writeB(user, 'First wording.');
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));
    expect(await within(cardB()).findByText("Couldn't send that. Message still in the box. Try sending again.")).toBeInTheDocument();
    await user.type(within(cardB()).getByRole('textbox', { name: 'What should work better?' }), ' Better wording.');
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(injected.seen[1].headers['Idempotency-Key']).not.toBe(injected.seen[0].headers['Idempotency-Key']);
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ submitted_text: 'First wording. Better wording.' })]);
  });

  it('keeps the draft and offers sign-in when the session expired, then sends after signing back in', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    const signIn = vi.fn();
    show(owner, { signIn });
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    await writeB(user, 'Written before the session ended.');
    delete browser.jar.fl_auth;
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));
    expect(await within(cardB()).findByText('Sign in again to send this. Message still in the box.')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(`frontline.draft.feedback.${owner.agentId}.welcome`)).toBe('Written before the session ended.');
    await user.click(within(cardB()).getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledTimes(1);
    browser.jar.fl_auth = owner.authToken;
    await user.click(within(cardB()).getByRole('button', { name: 'Send to the Frontline team' }));
    await screen.findByRole('region', { name: 'Sent to the team' });
    expect(await feedbackRows(owner)).toHaveLength(1);
  });

  it('restores an unsent draft and says so', async () => {
    const owner = freshOwner();
    window.sessionStorage.setItem(`frontline.draft.feedback.${owner.agentId}.welcome`, 'Half written.');
    show(owner);
    const field = await within(await screen.findByRole('region', { name: 'Tell the Frontline team' })).findByRole('textbox', { name: 'What should work better?' });
    expect(field).toHaveValue('Half written.');
    expect(within(cardB()).getByText('Unsent draft restored.')).toBeInTheDocument();
    expect(within(cardA()).queryByText('Unsent draft restored.')).not.toBeInTheDocument();
  });
});

describe('Card A: correct what Blake knows', () => {
  it('saves the message for the builder, creates a linked knowledge update, and opens review', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    await user.click(within(cardA()).getByRole('textbox', { name: 'What should Blake know or correct?' }));
    await user.paste('We are closed on Wednesdays.');
    await user.click(within(cardA()).getByRole('button', { name: 'Review changes' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app/knowledge'));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('notice')).toBe('feedback_saved');
    expect(params.get('agent')).toBe(owner.agentId);
    expect(await feedbackRows(owner)).toEqual([expect.objectContaining({ category: 'business_context', submitted_text: 'We are closed on Wednesdays.', source: 'owner' })]);
    const state = await scopeState(owner);
    const update = state.knowledgeLibrary.updates[params.get('update')];
    expect(update).toMatchObject({ inputType: 'text', baseAgentVersionId: owner.agentId });
    await waitFor(() => expect(extracted.map((input) => input.inputRef.text)).toContain('We are closed on Wednesdays.'));
    expect(state.firstVisit[owner.agentId].outcome).toBe('continued');
    expect(window.sessionStorage.getItem(`frontline.draft.knowledge.${owner.agentId}.welcome`)).toBeNull();
  });

  it('keeps the message and text when reading is unavailable, and a retry does not send the feedback twice', async () => {
    const owner = freshOwner();
    const user = userEvent.setup();
    show(owner);
    await screen.findByRole('heading', { level: 1, name: 'How was the conversation with Blake?' });
    extraction.available = {};
    await user.click(within(cardA()).getByRole('textbox', { name: 'What should Blake know or correct?' }));
    await user.paste('Add teeth whitening.');
    await user.click(within(cardA()).getByRole('button', { name: 'Review changes' }));
    expect(await within(cardA()).findByText("Message saved for the Frontline team, but the changes to review couldn't be prepared. Text still in the box. Try again.")).toBeInTheDocument();
    expect(window.location.pathname).not.toMatch(/knowledge/);
    expect(within(cardA()).getByRole('textbox', { name: 'What should Blake know or correct?' })).toHaveValue('Add teeth whitening.');
    expect(await feedbackRows(owner)).toHaveLength(1);

    extraction.available = { text: true };
    await user.click(within(cardA()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app/knowledge'));
    expect(await feedbackRows(owner)).toHaveLength(1);
    const updates = Object.values((await scopeState(owner)).knowledgeLibrary.updates);
    expect(updates).toHaveLength(1);
  });
});

describe('First visit: other states', () => {
  it('asks a signed-out visitor to sign in', async () => {
    const signIn = vi.fn();
    const user = userEvent.setup();
    show(freshOwner(), { signedIn: false, signIn });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see your receptionist.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Tell the Frontline team' })).not.toBeInTheDocument();
  });

  it('says so when the agent is not this account\'s', async () => {
    show(freshOwner(), { agentId: randomUUID() });
    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open receptionist' })).toHaveAttribute('href', '/app');
  });

  it('hides the cards and points to recovery when only an unfinished workspace exists', async () => {
    const owner = await seedClaimedOwner(harness.pg);
    await asOwner(harness.pg, async () => {
      await harness.pg.query("UPDATE frontline_claimed_targets SET target_kind = 'workspace' WHERE owner_scope_id = $1", [owner.scopeId]);
      await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify({ workspaces: { [owner.agentId]: { id: owner.agentId, businessName: 'Half Done' } }, agents: {}, demos: {} })]);
    });
    show(owner);
    expect(await screen.findByRole('heading', { level: 1, name: 'Blake needs your business details.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add business details' })).toHaveAttribute('href', `/app/workspaces/${owner.agentId}/setup`);
    expect(screen.queryByRole('region', { name: 'Correct what Blake knows' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument();
  });
});
