// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { sourceStoreErasers } from '../../server/api/post-onboarding/source-erasure.js';
import { browserClient, fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { changeState, deferred, publishFactInOtherTab } from './ui-helpers.js';
import { scopeState } from './ui-calls.js';

// MR-S5 (Choose sources) and the receptionist's own Knowledge page, against the real handler and a real migrated Postgres.
// Each test has its own owner. Every owner starts with two library sources: the onboarding website (with services and hours)
// and one typed note (a single FAQ), both used by Blake.
let harness; let browser;
const OWNER = { list: 0, acceptance: 1, dialog: 2, empty: 3, stale: 4, noServices: 5, pending: 6, nothing: 7 };
const OWNER_COUNT = Object.keys(OWNER).length;

beforeAll(async () => { harness = await createUiHarness({ owners: OWNER_COUNT, handlerContext: { voice: fakeVoice() } }); });
afterEach(() => { cleanup(); browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });

async function openKnowledge(name) {
  const owner = harness.owners[OWNER[name]];
  await publishFactInOtherTab(harness, owner, { value: 'Free parking behind the building' });
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  window.history.replaceState({}, '', `/app/agents/${owner.agentId}/knowledge`);
  render(<OwnerApp signIn={() => {}} />);
  await screen.findByRole('button', { name: 'Choose sources' });
  return owner;
}
const stateOf = (owner) => scopeState(harness.pg, owner.scopeId);
const pageList = () => /** @type {HTMLElement} */ (document.querySelector('.owner-source-list'));
const pageRows = () => within(pageList()).getAllByRole('listitem');
const chooseButton = () => screen.getByRole('button', { name: 'Choose sources' });
const puts = () => browser.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/knowledge-sources-selection'));
const openDialog = async () => { await userEvent.click(chooseButton()); return screen.findByRole('dialog', { name: 'Choose sources' }); };
const checkbox = (dialog, name) => within(dialog).getByRole('checkbox', { name: new RegExp(name) });

describe('Receptionist Knowledge page', () => {
  it('has a back link, the heading and one line, the sources Blake uses with their detail counts, and Choose sources', async () => {
    const owner = await openKnowledge('list');
    expect(screen.getByRole('link', { name: 'Back to Blake' })).toHaveAttribute('href', `/app/agents/${owner.agentId}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.getByText('What Blake knows about your business.')).toHaveClass('owner-lede');
    expect(document.title).toBe('Knowledge · Frontline');
    expect(pageRows().map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^riverside\.exampleWebsite · Added [A-Z][a-z]{2} \d{1,2} · \d+ details$/),
      expect.stringMatching(/^Your noteNote · Added [A-Z][a-z]{2} \d{1,2} · 1 detail$/),
    ]);
    expect(within(pageList()).queryByRole('button')).toBeNull();
    expect(chooseButton()).toHaveClass('bob-button--primary');
    expect(screen.queryByText(/needs knowledge/)).toBeNull();
  });
});

describe('Choose sources dialog', () => {
  it('lists one checkbox per business source with its detail count, all checked for Blake, and Cancel changes nothing', async () => {
    await openKnowledge('dialog');
    const dialog = await openDialog();
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => /** @type {HTMLInputElement} */ (box).checked)).toBe(true);
    expect(within(dialog).getByRole('list', { name: 'Sources to use' }).textContent).toMatch(/riverside\.exampleWebsite · Added [A-Z][a-z]{2} \d{1,2} · \d+ detailsYour noteNote · Added [A-Z][a-z]{2} \d{1,2} · 1 detail/);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(within(dialog).queryByText(/needs knowledge/)).toBeNull();
    await userEvent.click(checkbox(dialog, 'Your note'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts()).toHaveLength(0);
    expect(pageRows()).toHaveLength(2);
  });

  it('saves the chosen sources with the version the page was on, shows a spinner while it runs, then lists one source and drops Blake from Used by', async () => {
    const owner = await openKnowledge('acceptance');
    const before = (await stateOf(owner)).agentLineages[owner.agentId];
    expect(before.sourceIds).toHaveLength(2);
    const dialog = await openDialog();
    await userEvent.click(checkbox(dialog, 'Your note'));
    const held = deferred();
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => { if (init?.method === 'PUT') await held.promise; return inner(input, init); };
    try {
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      const save = within(dialog).getByRole('button', { name: 'Save' });
      expect(save).toBeDisabled();
      expect(save.querySelector('.owner-spinner')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    } finally { held.resolve(); }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(pageRows()).toHaveLength(1));
    expect(pageRows()[0].textContent).toMatch(/^riverside\.example/);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({ sourceIds: ['src-p1'], expectedAgentVersionId: before.currentAgentVersionId });
    const after = (await stateOf(owner)).agentLineages[owner.agentId];
    expect(after.sourceIds).toEqual(['src-p1']);
    expect(after.currentAgentVersionId).not.toBe(before.currentAgentVersionId);

    // The library shows the change: the website is still Blake's, the note is used by nobody and says nothing about it.
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Knowledge' }));
    await screen.findByRole('list', { name: 'Sources' });
    const rows = within(screen.getByRole('list', { name: 'Sources' })).getAllByRole('listitem');
    expect(within(rows.find((row) => row.textContent.includes('Website'))).getByText(/ · Used by Blake$/)).toBeInTheDocument();
    expect(rows.find((row) => row.textContent.includes('Your note')).textContent).not.toMatch(/Used by/);
  });

  it('shows the needs-knowledge message as soon as nothing is checked, still lets Save go through, and the page then says the same', async () => {
    const owner = await openKnowledge('nothing');
    const dialog = await openDialog();
    const message = 'Blake needs knowledge before it can take calls. Choose at least one source.';
    await userEvent.click(checkbox(dialog, 'riverside'));
    expect(within(dialog).queryByText(message)).toBeNull();
    await userEvent.click(checkbox(dialog, 'Your note'));
    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    await userEvent.click(checkbox(dialog, 'Your note'));
    expect(within(dialog).queryByText(message)).toBeNull();
    await userEvent.click(checkbox(dialog, 'Your note'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(pageList()).toBeNull();
    expect(puts()[0].body.sourceIds).toEqual([]);
    expect((await stateOf(owner)).agentLineages[owner.agentId].sourceIds).toEqual([]);

    // Home and the receptionist page keep working with nothing selected.
    cleanup();
    window.history.replaceState({}, '', '/app');
    render(<OwnerApp signIn={() => {}} />);
    await screen.findByRole('link', { name: /^Blake, Riverside Dental/ });
    cleanup();
    window.history.replaceState({}, '', `/app/agents/${owner.agentId}`);
    render(<OwnerApp signIn={() => {}} />);
    expect(await screen.findByRole('link', { name: 'Knowledge What Blake knows about your business.' })).toHaveAttribute('href', `/app/agents/${owner.agentId}/knowledge`);
  });

  it('says a newer version was saved, offers Reload, and Reload shows what the other tab saved', async () => {
    const owner = await openKnowledge('stale');
    const dialog = await openDialog();
    await publishFactInOtherTab(harness, owner, { value: 'Ask for Dana at the front desk' });
    await userEvent.click(checkbox(dialog, 'Your note'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Blake changed while this page was open. Reload to continue.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(puts()).toHaveLength(1);
    const reads = browser.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/knowledge')).length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(browser.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/knowledge')).length).toBeGreaterThan(reads));
    // Nothing was saved by the failed attempt: Blake still uses every source, now including the one the other tab added.
    await waitFor(() => expect(pageRows().length).toBeGreaterThanOrEqual(2));
    expect((await stateOf(owner)).agentLineages[owner.agentId].sourceIds).toHaveLength(pageRows().length);
    const reopened = await openDialog();
    expect(within(reopened).queryByText(/changed while this page was open/)).toBeNull();
    expect(within(reopened).getAllByRole('checkbox').every((box) => /** @type {HTMLInputElement} */ (box).checked)).toBe(true);
  });

  it('says to add a service when the chosen sources list none', async () => {
    const owner = await openKnowledge('noServices');
    const dialog = await openDialog();
    await userEvent.click(checkbox(dialog, 'riverside'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Add at least one service to a chosen source.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect((await stateOf(owner)).agentLineages[owner.agentId].sourceIds).toHaveLength(2);
    // Choosing the website again clears the message on the next change and saves.
    await userEvent.click(checkbox(dialog, 'riverside'));
    expect(within(dialog).queryByText('Add at least one service to a chosen source.')).toBeNull();
  });

  it('points to Knowledge when the business has no sources to choose from', async () => {
    const owner = await openKnowledge('empty');
    await changeState(harness, owner, (state) => { for (const source of Object.values(state.knowledgeLibrary.sources)) source.erasedAt = new Date().toISOString(); });
    cleanup(); resetOwnerApi();
    render(<OwnerApp signIn={() => {}} />);
    await screen.findByRole('button', { name: 'Choose sources' });
    const dialog = await openDialog();
    expect(within(dialog).getByText('No knowledge to choose from yet.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Add knowledge' })).toHaveAttribute('href', '/app/knowledge');
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('does not offer a source whose removal has started', async () => {
    // The store cleanup keeps failing, so the job stays open and the note is never selectable again.
    sourceStoreErasers.push({ name: 'always_down', appliesTo: () => true, erase: async () => { throw new Error('store unavailable'); } });
    try {
      const owner = await openKnowledge('pending');
      const client = browserClient(harness.app, owner.authToken);
      const view = await (await client.request('GET', `/v1/agents/${owner.agentId}/knowledge`)).json();
      const note = view.sources.find((source) => source.type !== 'website');
      const started = await client.request('POST', `/v1/agents/${owner.agentId}/knowledge-sources/${note.sourceId}/erase`, { body: { confirm: true, expectedPointerGeneration: view.pointerGeneration } });
      expect(started.status).toBe(202);
      cleanup(); resetOwnerApi();
      render(<OwnerApp signIn={() => {}} />);
      await screen.findByRole('button', { name: 'Choose sources' });
      await waitFor(() => expect(pageRows()).toHaveLength(1));
      const dialog = await openDialog();
      expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
      expect(within(dialog).queryByText('Your note')).toBeNull();
    } finally { sourceStoreErasers.length = 0; }
  });
});
