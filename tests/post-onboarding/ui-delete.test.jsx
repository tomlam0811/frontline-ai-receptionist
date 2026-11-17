// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { runReceptionistDeletion, startReceptionistDeletion } from '../../server/api/post-onboarding/receptionist-deletion.js';
import { asOwner, fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { changeState } from './ui-helpers.js';

// MR-J5, MR-S6: delete a receptionist from its page, and the "Deleting" card on Home. Real handler, real migrated Postgres.
// Each test uses its own claimed owner because a delete cannot be undone.
configure({ asyncUtilTimeout: 10000 });

let harness; let browser;
const OWNERS = { dialog: 0, confirm: 1, failure: 2, deleting: 3, two: 4, last: 5 };
afterEach(() => { browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ owners: 6, handlerContext: { voice: fakeVoice() } }); });

const ownerFor = (name) => harness.owners[OWNERS[name]];
const open = async (path, owner) => {
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => {}} />);
};
const bobPath = (owner) => `/app/agents/${owner.agentId}`;
const actorOf = (owner) => ({ scopeId: owner.scopeId, stableAgentId: owner.agentId, creatorRef: null, versionNumbers: {} });
const lineageOf = (owner) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0]?.state);
const openMenu = async () => {
  const identity = await screen.findByRole('region', { name: 'Blake' });
  await screen.findByRole('link', { name: 'Talk to Blake' });
  await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
  return screen.getByRole('group', { name: 'More actions' });
};

describe('Delete from the receptionist page (MR-S6)', () => {
  it('puts Delete last in the menu, in the danger style, and asks before deleting', async () => {
    const owner = ownerFor('dialog');
    await open(bobPath(owner), owner);
    const menu = await openMenu();
    const items = Array.from(menu.querySelectorAll('a, button'));
    expect(items.map((item) => item.textContent)).toEqual(['Rename', 'Pause', 'Share', 'Give feedback', 'Delete']);
    const del = items.at(-1);
    expect(del).toHaveClass('owner-menu__item--danger');
    await userEvent.click(del);

    const dialog = await screen.findByRole('dialog', { name: 'Delete Blake?' });
    expect(within(dialog).getByText("This deletes Blake, its conversations and its shared links. This can't be undone.")).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Delete Blake']);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete Blake' })).toHaveClass('owner-danger');

    // Cancel changes nothing: no request was sent and the receptionist is as it was.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(browser.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect((await lineageOf(owner)).receptionistDeletions).toBeUndefined();
    expect(screen.getByRole('link', { name: 'Talk to Blake' })).toBeInTheDocument();
  });

  it('closes on Escape without deleting', async () => {
    const owner = ownerFor('dialog');
    await open(bobPath(owner), owner);
    await userEvent.click(within(await openMenu()).getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog', { name: 'Delete Blake?' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(browser.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('names the receptionist the owner chose', async () => {
    const owner = ownerFor('dialog');
    await changeState(harness, owner, (state) => { state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, name: 'Ava', pointerGeneration: 1, currentAgentVersionId: owner.agentId, revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: state.agents[owner.agentId].knowledgeRevisionId, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] } }; });
    await open(bobPath(owner), owner);
    const identity = await screen.findByRole('region', { name: 'Ava' });
    await screen.findByRole('link', { name: 'Talk to Ava' });
    await userEvent.click(within(identity).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Ava?' });
    expect(within(dialog).getByText("This deletes Ava, its conversations and its shared links. This can't be undone.")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete Ava' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await changeState(harness, owner, (state) => { delete state.agentLineages[owner.agentId].name; });
  });

  it('deletes on confirm, shows the spinner, opens Home, and Home stops listing the receptionist', async () => {
    const owner = ownerFor('confirm');
    await open(bobPath(owner), owner);
    await userEvent.click(within(await openMenu()).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Blake?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Blake' }));
    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect(browser.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([bobPath(owner).replace('/app', '/v1')]);
    // The job finishes in the background: the card reads "Deleting Blake" and then the list is empty.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'No receptionist is saved to this account.' })).toBeInTheDocument());
    expect(screen.queryByText('Deleting Blake')).not.toBeInTheDocument();
    const state = await lineageOf(owner);
    expect(state.agentLineages[owner.agentId]).toBeUndefined();
    expect(Object.values(state.receptionistDeletions)[0].status).toBe('completed');
  });

  it('shows the spinner while the request is running', async () => {
    const owner = ownerFor('failure');
    await open(bobPath(owner), owner);
    await userEvent.click(within(await openMenu()).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Blake?' });
    const inner = globalThis.fetch;
    /** @type {() => void} */ let release = () => {};
    const held = new Promise((resolve) => { release = () => resolve(undefined); });
    globalThis.fetch = async (input, init = {}) => {
      if (init.method === 'DELETE') { await held; return new Response(JSON.stringify({ title: 'internal_error', detail: 'The request could not be completed.' }), { status: 500, headers: { 'content-type': 'application/json' } }); }
      return inner(input, init);
    };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Blake' }));
    const busy = await within(dialog).findByRole('button', { name: 'Delete Blake…' });
    expect(busy).toBeDisabled();
    expect(busy.querySelector('.owner-spinner')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    release();
    // A failed delete keeps the dialog open with the reason and lets the owner try again.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't delete Blake. Try again.");
    expect(within(dialog).getByRole('button', { name: 'Delete Blake' })).toBeEnabled();
    expect(window.location.pathname).toBe(bobPath(owner));
    globalThis.fetch = inner;
    expect((await lineageOf(owner)).receptionistDeletions).toBeUndefined();
  });
});

describe('Home while a receptionist is being deleted', () => {
  it('shows "Deleting Blake" with a chip and no link, and hides Feedback that has nothing to open', async () => {
    const owner = ownerFor('deleting');
    await startReceptionistDeletion({ db: fromPglite(harness.pg), actor: actorOf(owner) });
    await open('/app', owner);
    const card = await screen.findByRole('group', { name: 'Deleting Blake, Riverside Dental.' });
    expect(within(card).getByText('Deleting Blake')).toBeInTheDocument();
    expect(within(card).getByText('Riverside Dental')).toBeInTheDocument();
    expect(within(card).getByText('Deleting', { selector: '.owner-chip' })).toBeInTheDocument();
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(card.querySelector('a')).toBeNull();
    expect(screen.queryByText('View')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Blake, Riverside Dental/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Feedback' })).not.toBeInTheDocument();

    // Once the job is done the card is gone without a reload.
    await runReceptionistDeletion({ db: fromPglite(harness.pg), scopeId: owner.scopeId, jobId: Object.keys((await lineageOf(owner)).receptionistDeletions)[0] });
    await waitFor(() => expect(screen.queryByText('Deleting Blake')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'No receptionist is saved to this account.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up a receptionist' })).toHaveAttribute('href', '/');
  });

  it('keeps the other receptionist openable and sends Feedback to it', async () => {
    const owner = ownerFor('two');
    const second = crypto.randomUUID();
    await changeState(harness, owner, (state) => {
      const now = new Date().toISOString();
      const revision = (id) => ({ agentVersionId: id, knowledgeRevisionId: state.agents[owner.agentId].knowledgeRevisionId, parentAgentVersionId: null, kind: 'initial', createdAt: now, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null });
      state.agents[second] = { ...state.agents[owner.agentId], id: second };
      state.agentLineages = {
        [owner.agentId]: { stableAgentId: owner.agentId, name: 'Blake', status: 'deleting', pointerGeneration: 1, currentAgentVersionId: owner.agentId, revisions: [revision(owner.agentId)] },
        [second]: { stableAgentId: second, name: 'Ava', pointerGeneration: 1, currentAgentVersionId: second, revisions: [revision(second)] },
      };
    });
    await harness.pg.exec('RESET ROLE');
    await harness.pg.query("INSERT INTO frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id) VALUES ('agent',$1,$2,$3)", [second, owner.scopeId, owner.tenant]);
    await harness.pg.exec('SET ROLE frontline_app');
    await open('/app', owner);
    expect(await screen.findByRole('group', { name: 'Deleting Blake, Riverside Dental.' })).toBeInTheDocument();
    const active = screen.getByRole('link', { name: /^Ava, .*View\.$/ });
    expect(active).toHaveAttribute('href', `/app/agents/${second}`);
    const feedback = screen.getByRole('region', { name: 'Feedback' });
    expect(within(feedback).getByRole('link', { name: 'Send feedback' })).toHaveAttribute('href', `/app/agents/${second}/feedback`);
  });

  it('shows the receptionist as not found when its page is opened during a delete', async () => {
    const owner = ownerFor('deleting');
    await changeState(harness, owner, (state) => { state.agentLineages = { [owner.agentId]: { stableAgentId: owner.agentId, status: 'deleting', pointerGeneration: 1, currentAgentVersionId: owner.agentId, revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: null, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] } }; });
    cleanup();
    await open(bobPath(owner), owner);
    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't find that receptionist." })).toBeInTheDocument();
  });
});
