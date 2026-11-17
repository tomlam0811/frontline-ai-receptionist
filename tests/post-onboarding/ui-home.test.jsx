// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';

// The first render loads the app cold, which is slow when other test runs share the machine.
configure({ asyncUtilTimeout: 10000 });
import { asOwner, fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { addReceptionistByApi, clearKnowledgeByApi, pauseByApi } from './ui-add-receptionist-helpers.js';

let harness; let browser;
const clearNameCookie = () => { document.cookie = 'fl_first_name=; Max-Age=0; Path=/'; };
afterEach(() => { browser?.restore(); resetOwnerApi(); clearNameCookie(); });
afterAll(async () => { await harness?.pg.close(); });

const open = async (path, { signedIn = true, owner = harness.owner } = {}) => {
  browser = installBrowserFetch({ app: harness.app, authToken: signedIn ? owner.authToken : null });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => { window.__signIn = true; }} />);
};

beforeAll(async () => { harness = await createUiHarness({ owners: 3, handlerContext: { voice: fakeVoice() } }); });

describe('Home (PO-S2)', () => {
  it('greets the owner by first name, then shows the Receptionist card and opens it', async () => {
    document.cookie = 'fl_first_name=Tom; Path=/';
    await open('/app');
    const card = await screen.findByRole('link', { name: 'Blake, Riverside Dental, active. View.' });
    expect(card).toHaveAttribute('href', `/app/agents/${harness.owner.agentId}`);
    expect(screen.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Tom$/ })).toBeInTheDocument();
    expect(document.title).toBe('Home · Frontline');
    // The Receptionist section holds the name, the business name, the Active chip and the View label.
    const section = screen.getByRole('region', { name: 'Receptionist' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Receptionist' })).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(within(card).getByText('View')).toBeInTheDocument();
    expect(card.querySelector('.owner-chevron')).not.toBeInTheDocument();
    expect(card.querySelector('.owner-avatar')).not.toBeInTheDocument();
    expect(screen.queryByText('Not tested')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/phone|number|activate/i);
    await userEvent.click(card);
    await waitFor(() => expect(window.location.pathname).toBe(`/app/agents/${harness.owner.agentId}`));
  });

  it('greets without a name when sign-in supplied none', async () => {
    await open('/app');
    await screen.findByRole('link', { name: /^Blake, Riverside Dental/ });
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Good (morning|afternoon|evening)/);
  });

  it('shows a Feedback section that opens the feedback page for the receptionist', async () => {
    await open('/app');
    const section = await screen.findByRole('region', { name: 'Feedback' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Feedback' })).toBeInTheDocument();
    expect(within(section).getByText('Tell the Frontline team how we can serve you better.')).toBeInTheDocument();
    const button = within(section).getByRole('link', { name: 'Send feedback' });
    expect(button).toHaveClass('bob-button', 'bob-button--small');
    expect(button).toHaveAttribute('href', `/app/agents/${harness.owner.agentId}/feedback`);
    await userEvent.click(button);
    await waitFor(() => expect(window.location.pathname).toBe(`/app/agents/${harness.owner.agentId}/feedback`));
  });

  it('shows the untested line after a published change, from the server state', async () => {
    await asOwner(harness.pg, async () => {
      const state = (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [harness.owner.scopeId])).rows[0].state;
      state.agentLineages = { [harness.owner.agentId]: { stableAgentId: harness.owner.agentId, pointerGeneration: 2, currentAgentVersionId: harness.owner.agentId, revisions: [
        { agentVersionId: 'older', knowledgeRevisionId: null, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null },
        { agentVersionId: harness.owner.agentId, knowledgeRevisionId: state.agents[harness.owner.agentId].knowledgeRevisionId, parentAgentVersionId: 'older', kind: 'knowledge', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] } };
      await harness.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [harness.owner.scopeId, JSON.stringify(state)]);
    });
    await open('/app');
    expect(await screen.findByText('Blake has new changes. Talk to Blake to hear them before sharing.')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Not tested')).not.toBeInTheDocument();
  });

  it('shows one card per receptionist, each with its own chip: Active, Needs knowledge, and Paused ahead of Needs knowledge (MR-S1, MR-T16)', async () => {
    const owner = harness.owners[1];
    const sam = await addReceptionistByApi(harness, owner, 'Sam');
    const mia = await addReceptionistByApi(harness, owner, 'Mia');
    await clearKnowledgeByApi(harness, owner, sam);
    await clearKnowledgeByApi(harness, owner, mia);
    await pauseByApi(harness, owner, mia.stableAgentId);
    await open('/app', { owner });
    const active = await screen.findByRole('link', { name: 'Blake, Riverside Dental, active. View.' });
    expect(within(active).getByText('Active')).toBeInTheDocument();

    const needs = screen.getByRole('link', { name: 'Sam, Riverside Dental, needs knowledge. View.' });
    expect(needs).toHaveAttribute('href', `/app/agents/${sam.stableAgentId}`);
    expect(within(needs).getByText('Needs knowledge')).toBeInTheDocument();
    expect(within(needs).getByText('Sam needs knowledge before it can take calls. Choose at least one source.')).toBeInTheDocument();
    expect(within(needs).queryByText('Active')).not.toBeInTheDocument();

    // Paused wins on the card, and shows no needs-knowledge sentence.
    const paused = screen.getByRole('link', { name: 'Mia, Riverside Dental, paused. View.' });
    expect(within(paused).getByText('Paused')).toBeInTheDocument();
    expect(within(paused).queryByText('Needs knowledge')).not.toBeInTheDocument();
    expect(within(paused).queryByText(/needs knowledge/)).not.toBeInTheDocument();
  });

  it('asks a signed-out visitor to sign in', async () => {
    await open('/app', { signedIn: false });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see your receptionist.' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(window.__signIn).toBe(true);
    // Nothing to navigate or sign out of yet.
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
  });

  it('says so when an unfinished workspace is the only thing saved, and points to recovery', async () => {
    const lonely = await createUiHarness({ owners: 0 });
    try {
      const { seedClaimedOwner } = await import('./fixtures.js');
      const owner = await seedClaimedOwner(lonely.pg);
      await asOwner(lonely.pg, async () => {
        await lonely.pg.query("UPDATE frontline_claimed_targets SET target_kind = 'workspace' WHERE owner_scope_id = $1", [owner.scopeId]);
        await lonely.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify({ workspaces: { [owner.agentId]: { id: owner.agentId, businessName: 'Half Done' } }, agents: {}, demos: {} })]);
      });
      browser = installBrowserFetch({ app: lonely.app, authToken: owner.authToken });
      window.history.replaceState({}, '', '/app');
      render(<OwnerApp />);
      // PO-S2 "No agent yet" state: the h1 itself, not a secondary heading under "Receptionist".
      expect(await screen.findByRole('heading', { level: 1, name: 'Blake needs your business details.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Add business details' })).toHaveAttribute('href', `/app/workspaces/${owner.agentId}/setup`);
    } finally { await lonely.pg.close(); }
  });

  it('says so when the account has nothing saved', async () => {
    const empty = await createUiHarness({ owners: 0 });
    try {
      const { seedSession } = await import('./fixtures.js');
      const session = await seedSession(empty.pg);
      browser = installBrowserFetch({ app: empty.app, authToken: session.authToken });
      window.history.replaceState({}, '', '/app');
      render(<OwnerApp />);
      expect(await screen.findByRole('heading', { level: 1, name: 'No receptionist is saved to this account.' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Set up a receptionist' })).toHaveAttribute('href', '/');
    } finally { await empty.pg.close(); }
  });
});

describe('Sign out', () => {
  // The scaffold harness (createUiHarness) serves only the post-onboarding route table, which does not yet
  // proxy the existing POST /v1/auth/logout (that lives in the connected createApiHandler in server/api/service.js,
  // covered by its own suite). These tests confirm the owner app calls it and clears local state either way.
  it('calls the sign-out endpoint and clears draft and guest session-storage keys, keeping unrelated keys', async () => {
    window.sessionStorage.setItem('frontline.draft.feedback.some-agent', 'unsent text');
    window.sessionStorage.setItem('frontline.draft.knowledge.some-agent.hours', 'unsent hours');
    window.sessionStorage.setItem('frontline.guest.started', '1');
    window.sessionStorage.setItem('unrelated.key', 'keep me');
    await open('/app');
    await screen.findByRole('heading', { level: 1, name: 'Welcome back' });
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(browser.calls.some((call) => call.method === 'POST' && call.path === '/v1/auth/logout')).toBe(true));
    expect(window.sessionStorage.getItem('frontline.draft.feedback.some-agent')).toBeNull();
    expect(window.sessionStorage.getItem('frontline.draft.knowledge.some-agent.hours')).toBeNull();
    expect(window.sessionStorage.getItem('frontline.guest.started')).toBeNull();
    expect(window.sessionStorage.getItem('unrelated.key')).toBe('keep me');
  });

  it('still clears local draft state when the server call fails', async () => {
    window.sessionStorage.setItem('frontline.draft.feedback.some-agent', 'unsent text');
    await open('/app');
    await screen.findByRole('heading', { level: 1, name: 'Welcome back' });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (String(input).endsWith('/v1/auth/logout')) throw new TypeError('Failed to fetch');
      return inner(input, init);
    };
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(window.sessionStorage.getItem('frontline.draft.feedback.some-agent')).toBeNull());
    globalThis.fetch = inner;
  });

  it('is not shown on the guest page', async () => {
    browser = installBrowserFetch({ app: harness.app, authToken: null });
    window.history.replaceState({}, '', '/shared');
    render(<OwnerApp signIn={() => {}} />);
    await screen.findByRole('heading', { level: 1, name: 'Talk to the receptionist' });
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});
