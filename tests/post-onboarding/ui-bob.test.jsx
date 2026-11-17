// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { asOwner, fakeVoice, seedClaimedOwner, seedSession } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { changeState } from './ui-helpers.js';

// Blake detail (PO-S9) against the real handler and a real migrated Postgres.
// Each test uses its own claimed owner so the versions they publish do not leak into each other.

let harness; let browser;
const OWNERS = { detail: 0, reviewed: 1, keyboard: 2, menu: 3, pause: 4, pausedNeedsKnowledge: 5, needsKnowledge: 6, selected: 7 };
afterEach(() => { browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ owners: Object.keys(OWNERS).length, handlerContext: { voice: fakeVoice() } }); });

const ownerFor = (name) => harness.owners[OWNERS[name]];
/** @param {string} path @param {{owner?: any, signedIn?: boolean, target?: any}} [options] */
const open = async (path, { signedIn = true, owner = harness.owner, target = harness } = {}) => {
  browser = installBrowserFetch({ app: target.app, authToken: signedIn ? owner.authToken : null });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => { /** @type {any} */ (window).__signIn = true; }} />);
};
const bobPath = (owner, section = '') => `/app/agents/${owner.agentId}${section}`;

describe('Blake detail (PO-S9)', () => {
  it('shows the identity card with Talk, a menu for Rename, Share, Give feedback and Delete, and the Knowledge, Capabilities and Conversations cards', async () => {
    const owner = ownerFor('detail');
    await open(bobPath(owner), { owner });
    const identity = await screen.findByRole('region', { name: 'Blake' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Blake' })).toHaveFocus());
    expect(document.title).toBe('Blake · Frontline');
    expect(within(identity).getByText('Riverside Dental')).toBeInTheDocument();
    expect(within(identity).queryByText(/Version/)).not.toBeInTheDocument();
    expect(within(identity).queryByText('Not tested')).not.toBeInTheDocument();
    expect(within(identity).queryByText('Reviewed by you')).not.toBeInTheDocument();
    expect(identity.querySelector('.owner-avatar')).not.toBeInTheDocument();

    // Talk is the one primary button. Rename, Share and Give feedback sit in the menu inside the identity card.
    const talk = within(identity).getByRole('link', { name: 'Talk to Blake' });
    expect(talk).toHaveAttribute('href', bobPath(owner, '/talk'));
    expect(talk).toHaveClass('bob-button--primary');
    expect(document.querySelectorAll('.bob-button--primary')).toHaveLength(1);
    const menuButton = within(identity).getByRole('button', { name: 'More actions' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Give feedback' })).not.toBeInTheDocument();
    await userEvent.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('group', { name: 'More actions' });
    expect(within(menu).getAllByRole('button').concat(within(menu).getAllByRole('link')).map((item) => item.textContent).sort()).toEqual(['Delete', 'Give feedback', 'Pause', 'Rename', 'Share']);
    expect(within(menu).getByRole('button', { name: 'Rename' })).toHaveFocus();
    expect(within(menu).getByRole('link', { name: 'Give feedback' })).toHaveAttribute('href', bobPath(owner, '/feedback'));
    expect(screen.queryByText('Share Blake')).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton).toHaveFocus();

    // Knowledge, Capabilities and Conversations are one pattern: an h2 title, one muted line, and the whole card is the link.
    const cards = Array.from(document.querySelectorAll('.owner-bob__main > a.owner-link-card'));
    expect(cards.map((link) => [link.querySelector('h2').textContent, link.querySelector('span').textContent, link.getAttribute('href')])).toEqual([
      ['Knowledge', 'What Blake knows about your business.', bobPath(owner, '/knowledge')],
      ['Capabilities', 'What Blake can do.', bobPath(owner, '/capabilities')],
      ['Conversations', 'Call summaries and transcripts.', bobPath(owner, '/conversations')],
    ]);
    expect(new Set(cards.map((link) => link.querySelector('h2').className)).size).toBe(1);
    expect(screen.getByRole('link', { name: 'Knowledge What Blake knows about your business.' })).toBeInTheDocument();
    // No separate Manage knowledge link, no source list, no counts.
    expect(screen.queryByRole('link', { name: 'Manage knowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/riverside\.example|\d+ (sources?|details?)/);
    expect(screen.queryByRole('navigation', { name: 'Receptionist sections' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/activate|provision/i);
    expect(screen.getByRole('link', { name: 'Contact the Frontline team' })).toHaveAttribute('href', expect.stringMatching(/\/feedback\?topic=phone$/));
    expect(screen.getByText(/to set up a phone number for Blake\./)).toBeInTheDocument();
  });

  it('reaches the menu, Talk and the cards with the keyboard in reading order', async () => {
    const owner = ownerFor('keyboard');
    await open(bobPath(owner), { owner });
    await screen.findByRole('region', { name: 'Blake' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Blake' })).toHaveFocus());
    const order = [];
    for (let step = 0; step < 6; step += 1) { await userEvent.tab(); order.push((document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent).replace(/\s+/g, ' ').trim()); }
    expect(order).toEqual(['More actions', 'Talk to Blake', 'Contact the Frontline team', 'KnowledgeWhat Blake knows about your business.', 'CapabilitiesWhat Blake can do.', 'ConversationsCall summaries and transcripts.']);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toHaveTextContent('Capabilities');
  });

  it('keeps the identity card to the name and the business, even for a tested and reviewed version', async () => {
    const owner = ownerFor('reviewed');
    await changeState(harness, owner, (state) => {
      state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, pointerGeneration: 1, currentAgentVersionId: owner.agentId, revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: null, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: '2026-09-25T10:00:00.000Z', ownerReviewedAt: '2026-09-25T10:05:00.000Z' }] } };
    });
    await open(bobPath(owner), { owner });
    const identity = await screen.findByRole('region', { name: 'Blake' });
    expect(within(identity).queryByText('Tested')).not.toBeInTheDocument();
    expect(within(identity).queryByText('Reviewed by you')).not.toBeInTheDocument();
    expect(within(identity).queryByText('Not tested')).not.toBeInTheDocument();
  });

  it('disables Talk and Share with the reason when voice is unavailable, and keeps Give feedback', async () => {
    const quiet = await createUiHarness({ handlerContext: { voice: { ...fakeVoice(), isConfigured: () => false } } });
    try {
      await open(bobPath(quiet.owner), { owner: quiet.owner, target: quiet });
      await screen.findByRole('heading', { level: 1, name: 'Blake' });
      const talk = screen.getByRole('button', { name: 'Talk to Blake' });
      expect(talk).toBeDisabled();
      expect(talk).toHaveAccessibleDescription("Calls aren't available right now. Please contact the Frontline team.");
      await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
      expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
      expect(screen.getByRole('link', { name: 'Give feedback' })).toHaveAttribute('href', bobPath(quiet.owner, '/feedback'));
      expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
    } finally { await quiet.pg.close(); }
  });

  it('asks a signed-out visitor to sign in', async () => {
    const owner = ownerFor('detail');
    await open(bobPath(owner), { owner, signedIn: false });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to see your receptionist.' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(/** @type {any} */ (window).__signIn).toBe(true);
  });

  it('does not open another owner\'s Blake', async () => {
    const other = await seedSession(harness.pg);
    await open(bobPath(ownerFor('detail')), { owner: { authToken: other.authToken } });
    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).toBeInTheDocument();
    expect(screen.queryByText('Riverside Dental')).not.toBeInTheDocument();
  });

  it('says Blake is not ready for an unfinished workspace, hides the sections and disables Talk', async () => {
    const lonely = await createUiHarness({ owners: 0 });
    try {
      const owner = await seedClaimedOwner(lonely.pg);
      await asOwner(lonely.pg, async () => {
        await lonely.pg.query("UPDATE frontline_claimed_targets SET target_kind = 'workspace' WHERE owner_scope_id = $1", [owner.scopeId]);
        await lonely.pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify({ workspaces: { [owner.agentId]: { id: owner.agentId, businessName: 'Half Done' } }, agents: {}, demos: {} })]);
      });
      await open(bobPath(owner), { owner, target: lonely });
      expect(await screen.findByRole('heading', { level: 1, name: "Blake isn't ready yet." })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Add business details' })).toHaveAttribute('href', `/app/workspaces/${owner.agentId}/setup`);
      expect(screen.getByText('Finish your business details first.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Talk to Blake' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
      expect(within(screen.getByRole('main')).queryByRole('link', { name: 'Capabilities' })).not.toBeInTheDocument();
      expect(within(screen.getByRole('main')).queryByRole('link', { name: 'Conversations' })).not.toBeInTheDocument();
      cleanup(); resetOwnerApi(); browser.restore();
      await open(bobPath(owner, '/capabilities'), { owner, target: lonely });
      expect(await screen.findByRole('heading', { level: 1, name: "Blake isn't ready yet." })).toBeInTheDocument();
    } finally { await lonely.pg.close(); }
  });
});

describe('Pause and resume (MR-J4)', () => {
  it('asks before pausing, then shows Paused, disables Talk and Share with the reason, and resumes', async () => {
    const owner = ownerFor('pause');
    await open(bobPath(owner), { owner });
    const identity = await screen.findByRole('region', { name: 'Blake' });
    await screen.findByRole('link', { name: 'Talk to Blake' });
    expect(within(identity).queryByText('Paused')).not.toBeInTheDocument();

    // Cancel leaves the receptionist active.
    await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    let dialog = await screen.findByRole('dialog', { name: 'Pause Blake?' });
    expect(within(dialog).getByText(/stops taking calls and shared links stop working. Unused links are revoked/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Talk to Blake' })).toBeInTheDocument();

    // Pause confirms and the page shows the paused state.
    await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    dialog = await screen.findByRole('dialog', { name: 'Pause Blake?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(within(identity).getByText('Paused')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const talk = screen.getByRole('button', { name: 'Talk to Blake' });
    expect(talk).toBeDisabled();
    expect(talk).toHaveAccessibleDescription('Blake is paused.');
    await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    // Resume is in the menu and under the reason.
    expect(screen.getAllByRole('button', { name: 'Resume' })).toHaveLength(2);
    await userEvent.keyboard('{Escape}');

    // Home shows the chip, and conversations stay reachable.
    expect(screen.getByRole('link', { name: 'Conversations Call summaries and transcripts.' })).toBeInTheDocument();
    cleanup(); resetOwnerApi(); browser.restore();
    await open('/app', { owner });
    const card = await screen.findByRole('link', { name: 'Blake, Riverside Dental, paused. View.' });
    expect(within(card).getByText('Paused')).toBeInTheDocument();
    cleanup(); resetOwnerApi(); browser.restore();

    // Resume from the page brings Talk back.
    await open(bobPath(owner), { owner });
    const again = await screen.findByRole('region', { name: 'Blake' });
    await userEvent.click(await within(again).findByRole('button', { name: 'Resume' }));
    await screen.findByRole('link', { name: 'Talk to Blake' });
    expect(within(again).queryByText('Paused')).not.toBeInTheDocument();
  });

  it('disables Resume with the needs-knowledge reason when a paused receptionist has no source selected (MR-D10)', async () => {
    const owner = ownerFor('pausedNeedsKnowledge');
    await changeState(harness, owner, (state) => {
      state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, pointerGeneration: 1, currentAgentVersionId: owner.agentId, status: 'paused', sourceIds: [], revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: null, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] } };
    });
    await open(bobPath(owner), { owner });
    const identity = await screen.findByRole('region', { name: 'Blake' });
    const reason = 'Blake needs knowledge before it can take calls. Choose at least one source.';
    // Paused wins on the chip and on Talk; Resume carries the needs-knowledge reason.
    expect(within(identity).getByText('Paused')).toBeInTheDocument();
    expect(within(identity).queryByText('Needs knowledge')).not.toBeInTheDocument();
    expect(within(identity).getByRole('button', { name: 'Talk to Blake' })).toHaveAccessibleDescription('Blake is paused.');
    const resume = within(identity).getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription(reason);
    expect(within(identity).getByText(reason)).toBeInTheDocument();
    await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
    expect(within(screen.getByRole('group', { name: 'More actions' })).getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(browser.calls.filter((call) => call.path.endsWith('/resume'))).toHaveLength(0);
  });
});

describe('Needs knowledge (MR-D10, MR-T16)', () => {
  const reason = 'Blake needs knowledge before it can take calls. Choose at least one source.';

  it('shows the chip and the message with Choose sources, and disables Talk and Share with the reason', async () => {
    const owner = ownerFor('needsKnowledge');
    await changeState(harness, owner, (state) => {
      state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, pointerGeneration: 1, currentAgentVersionId: owner.agentId, status: 'active', sourceIds: [], revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: null, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] } };
    });
    await open(bobPath(owner), { owner });
    const identity = await screen.findByRole('region', { name: 'Blake' });
    expect(within(identity).getByText('Needs knowledge')).toBeInTheDocument();
    expect(within(identity).queryByText('Paused')).not.toBeInTheDocument();
    const talk = within(identity).getByRole('button', { name: 'Talk to Blake' });
    expect(talk).toBeDisabled();
    expect(talk).toHaveAccessibleDescription(reason);
    expect(within(identity).getByText(reason)).toBeInTheDocument();
    const choose = within(identity).getByRole('link', { name: 'Choose sources' });
    expect(choose).toHaveAttribute('href', `/app/agents/${owner.agentId}/knowledge`);
    await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(choose);
    await waitFor(() => expect(window.location.pathname).toBe(`/app/agents/${owner.agentId}/knowledge`));
    expect(await screen.findByRole('button', { name: 'Choose sources' })).toBeInTheDocument();
  });

  it('shows no chip, message or Choose sources link when a source is selected', async () => {
    const owner = ownerFor('selected');
    await open(bobPath(owner), { owner });
    const identity = await screen.findByRole('region', { name: 'Blake' });
    await screen.findByRole('link', { name: 'Talk to Blake' });
    expect(within(identity).queryByText('Needs knowledge')).not.toBeInTheDocument();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Choose sources' })).not.toBeInTheDocument();
  });
});
