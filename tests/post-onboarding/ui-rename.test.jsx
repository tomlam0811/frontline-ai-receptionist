// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { changeState, deferred } from './ui-helpers.js';

// MR-J3 and MR-T5: the Rename dialog on the receptionist page, against the real handler and a real migrated Postgres.
// Each test uses its own claimed owner so a name chosen in one does not leak into another.

let harness; let browser;
afterEach(() => { cleanup(); browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ owners: 7, handlerContext: { voice: fakeVoice() } }); });

const OWNERS = { rename: 0, invalid: 1, taken: 2, cancel: 3, busy: 4, home: 5, failure: 6 };
const ownerFor = (name) => harness.owners[OWNERS[name]];
const bobPath = (owner, section = '') => `/app/agents/${owner.agentId}${section}`;
const open = async (path, owner) => {
  browser?.restore(); resetOwnerApi();
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  window.history.replaceState({}, '', path);
  return render(<OwnerApp signIn={() => {}} />);
};
/** Opens the receptionist page and the Rename dialog. Returns the dialog. */
async function openRename(owner) {
  await open(bobPath(owner), owner);
  await screen.findByRole('heading', { level: 1, name: /.+/ });
  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
  return screen.findByRole('dialog', { name: 'Rename' });
}
/** @param {any} owner @returns {Promise<any>} */
const stateOf = async (owner) => { let saved; await changeState(harness, owner, (state) => { saved = structuredClone(state); }); return saved; };

describe('Rename dialog (MR-J3)', () => {
  it('lists Rename first in the receptionist menu', async () => {
    const owner = ownerFor('rename');
    await open(bobPath(owner), owner);
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    const items = within(screen.getByRole('group', { name: 'More actions' })).getAllByRole('button').map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Pause', 'Share', 'Delete']);
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
  });

  it('opens with the current name in the field and focus in it, and the name is selected', async () => {
    const dialog = await openRename(ownerFor('rename'));
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Blake');
    expect(field).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('saves the new name, shows it on the page and on Home, and publishes no version (MR-T5)', async () => {
    const owner = ownerFor('rename');
    const dialog = await openRename(owner);
    const versionsBefore = (await stateOf(owner)).agentLineages?.[owner.agentId]?.revisions?.length ?? 1;
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(field);
    await userEvent.type(field, '  Sam ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { level: 1, name: 'Sam' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Talk to Sam' })).toBeInTheDocument();
    expect(screen.queryByText('Talk to Blake')).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Sam · Frontline'));
    expect(browser.calls.filter((call) => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: `/v1/agents/${owner.agentId}/name`, body: { name: 'Sam' } }]);

    const saved = await stateOf(owner);
    expect(saved.agentLineages[owner.agentId].name).toBe('Sam');
    expect(saved.agentLineages[owner.agentId].revisions).toHaveLength(versionsBefore);

    // The name survives a reload and shows on Home, the Capabilities page.
    cleanup();
    await open('/app', owner);
    expect(await screen.findByText('Sam')).toBeInTheDocument();
    cleanup();
    await open(bobPath(owner, '/capabilities'), owner);
    expect(await screen.findByText('Choose what Sam can do.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Sam' })).toBeInTheDocument();
  });

  it('shows the name on Home for a receptionist that was renamed elsewhere', async () => {
    const owner = ownerFor('home');
    await changeState(harness, owner, (state) => {
      const lineage = { stableAgentId: owner.agentId, pointerGeneration: 1, currentAgentVersionId: owner.agentId, name: 'Riley', revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: state.agents[owner.agentId].knowledgeRevisionId, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] };
      state.agentLineages = { [owner.agentId]: lineage };
    });
    await open('/app', owner);
    expect(await screen.findByText('Riley')).toBeInTheDocument();
    expect(screen.queryByText('Blake')).not.toBeInTheDocument();
  });

  it('refuses a name that is empty, too long or made of symbols, inline, before anything is sent', async () => {
    const owner = ownerFor('invalid');
    const dialog = await openRename(owner);
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    for (const value of ['   ', 'x'.repeat(31), '12345', '!!!']) {
      await userEvent.clear(field);
      await userEvent.type(field, value);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Use 1 to 30 letters.');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAccessibleDescription(/Use 1 to 30 letters/);
    }
    expect(browser.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    // Typing again clears the error.
    await userEvent.clear(field);
    await userEvent.type(field, 'Sam');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says when the name is already used by another receptionist, ignoring case, and keeps the dialog open', async () => {
    const owner = ownerFor('taken');
    await changeState(harness, owner, (state) => {
      const otherId = '11111111-1111-4111-8111-111111111111';
      state.agentLineages = { ...state.agentLineages, [owner.agentId]: { stableAgentId: owner.agentId, pointerGeneration: 1, currentAgentVersionId: owner.agentId, revisions: [{ agentVersionId: owner.agentId, knowledgeRevisionId: state.agents[owner.agentId].knowledgeRevisionId, parentAgentVersionId: null, kind: 'initial', createdAt: null, createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }] }, [otherId]: { stableAgentId: otherId, name: 'Riley', pointerGeneration: 1, currentAgentVersionId: otherId, revisions: [] } };
    });
    const dialog = await openRename(owner);
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'rILEY');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That name is already used.');
    expect(screen.getByRole('dialog', { name: 'Rename' })).toBeInTheDocument();
    expect(field).toHaveValue('rILEY');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('heading', { level: 1, name: 'Blake' })).toBeInTheDocument();
  });

  it('cancels with the button or Escape and changes nothing', async () => {
    const owner = ownerFor('cancel');
    let dialog = await openRename(owner);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Zed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    dialog = await screen.findByRole('dialog', { name: 'Rename' });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Blake');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Zed');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Blake' })).toBeInTheDocument();
    expect(browser.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
  });

  it('closes without a request when the name is unchanged', async () => {
    const owner = ownerFor('cancel');
    const dialog = await openRename(owner);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(browser.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
  });

  it('shows a spinner on Save while it saves, and Escape does not close the dialog until it is done', async () => {
    const owner = ownerFor('busy');
    const dialog = await openRename(owner);
    const gate = deferred();
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if ((init.method ?? 'GET') === 'PATCH') await gate.promise;
      return inner(input, init);
    };
    try {
      const field = within(dialog).getByRole('textbox', { name: 'Name' });
      await userEvent.clear(field);
      await userEvent.type(field, 'Jordan');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      const save = within(dialog).getByRole('button', { name: 'Save' });
      expect(save).toBeDisabled();
      expect(save.querySelector('.owner-spinner')).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      await userEvent.keyboard('{Escape}');
      expect(screen.getByRole('dialog', { name: 'Rename' })).toBeInTheDocument();
      gate.resolve();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByRole('heading', { level: 1, name: 'Jordan' })).toBeInTheDocument();
    } finally { globalThis.fetch = inner; }
  });

  it('keeps the dialog and the typed name when the save fails, and says so', async () => {
    const owner = ownerFor('failure');
    const dialog = await openRename(owner);
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if ((init.method ?? 'GET') === 'PATCH') return new Response(JSON.stringify({ title: 'unavailable', detail: 'down', status: 503 }), { status: 503, headers: { 'content-type': 'application/json' } });
      return inner(input, init);
    };
    try {
      const field = within(dialog).getByRole('textbox', { name: 'Name' });
      await userEvent.clear(field);
      await userEvent.type(field, 'Sam');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent("That didn't work. Try again.");
      expect(field).toHaveValue('Sam');
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    } finally { globalThis.fetch = inner; }
  });
});
