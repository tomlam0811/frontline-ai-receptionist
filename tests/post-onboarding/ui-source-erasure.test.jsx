// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { pollSettings } from '../../src/components/owner/KnowledgeParts.jsx';
import { sourceStoreErasers } from '../../server/api/post-onboarding/source-erasure.js';
import { fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { addReceptionist, publishFactInOtherTab } from './ui-helpers.js';

// PO-A16 on the Knowledge screen against the real handler and a real migrated Postgres: the compact list of sources,
// the remove confirm, the row leaving at once, and the one notice shown when cleanup keeps failing.
let harness; let browser;
const OWNER = { confirm: 0, retry: 1, shared: 2, sharedOnly: 3 };

beforeAll(async () => {
  pollSettings.intervalMs = 25;
  harness = await createUiHarness({ owners: 4, handlerContext: { voice: fakeVoice() } });
});
afterEach(() => { cleanup(); sourceStoreErasers.length = 0; browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });

/** `others` are extra receptionists written into the business first, each `{ name, sourceIds }` (see addReceptionist). */
async function openWithTypedNote(index, others = []) {
  const owner = harness.owners[index];
  await publishFactInOtherTab(harness, owner, { value: 'Free parking behind the building' });
  for (const other of others) await addReceptionist(harness, owner, other);
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  window.history.replaceState({}, '', others.length ? `/app/knowledge?agent=${owner.agentId}` : '/app/knowledge');
  render(<OwnerApp signIn={() => {}} />);
  await screen.findByRole('list', { name: 'Sources' });
  return owner;
}
const sources = () => screen.getByRole('list', { name: 'Sources' });
const noteRow = () => within(sources()).getAllByRole('listitem').find((row) => row.textContent.includes('Your note'));
const erasePosts = () => browser.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/erase'));
const OLD_WORDS = /everywhere|backup|Deleting|conversation|cleanup|feedback/i;

describe('Sources used by other receptionists', () => {
  const NOTE_ONLY = (own) => own.filter((id) => id !== 'src-p1');
  const websiteRow = () => within(sources()).getAllByRole('listitem').find((row) => row.textContent.includes('Website'));

  it('shows Used by with every receptionist that uses a source, and nothing for a source nobody uses', async () => {
    // Sam uses only the note. Riley uses nothing yet, so the website is Blake's alone.
    await openWithTypedNote(OWNER.shared, [{ name: 'Sam', sourceIds: NOTE_ONLY }, { name: 'Riley', sourceIds: [] }]);
    expect(within(noteRow()).getByText(/ · Used by Blake, Sam$/)).toBeTruthy();
    expect(within(websiteRow()).getByText(/ · Used by Blake$/)).toBeTruthy();
    expect(screen.queryByText(/Riley/)).toBeNull();
    expect(within(sources()).queryByText(/none/i)).toBeNull();
    // With several receptionists the description does not name one of them.
    expect(screen.getByText('What every receptionist can use.')).toBeTruthy();
  });

  it('names the other receptionists in the removal confirmation, then removes the source for all of them', async () => {
    await openWithTypedNote(OWNER.sharedOnly, [{ name: 'Sam', sourceIds: NOTE_ONLY }, { name: 'Riley', sourceIds: 'all' }]);
    await userEvent.click(within(noteRow()).getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Blake will stop using it. Riley and Sam also use this source.')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(OLD_WORDS);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // A source used by one other receptionist says "uses".
    await userEvent.click(within(websiteRow()).getByRole('button'));
    expect(within(await screen.findByRole('dialog')).getByText('Blake will stop using it. Riley also uses this source.')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(erasePosts()).toHaveLength(0);

    await userEvent.click(within(noteRow()).getByRole('button'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove typed note' }));
    await screen.findByText('Your note removed.');
    expect(erasePosts()).toHaveLength(1);
  });
});

describe('Remove a source from Blake', () => {
  it('lists name, type and date with one Remove per row, asks first with Cancel focused, then drops the row and says so', async () => {
    await openWithTypedNote(OWNER.confirm);
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Sources' })).toBeTruthy();
    const website = within(sources()).getAllByRole('listitem').find((row) => row.textContent.includes('Website'));
    expect(website.textContent).toMatch(/^riverside\.exampleWebsite · Added [A-Z][a-z]{2} \d{1,2} · \d+ details? · Used by BlakeRemove$/);
    expect(within(website).getByText(/ · Used by Blake$/)).toBeTruthy();
    expect(within(noteRow()).getByText(/ · 1 detail/)).toBeTruthy();
    expect(within(website).getByText('riverside.example')).toBeTruthy();
    expect(within(noteRow()).getAllByRole('button')).toHaveLength(1);
    expect(within(website).getByRole('button', { name: 'Remove website: riverside.example' })).toBeTruthy();
    expect(within(noteRow()).getByRole('button', { name: 'Remove typed note: Your note' })).toBeTruthy();

    await userEvent.click(within(noteRow()).getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove Your note?' })).toBeTruthy();
    expect(within(dialog).getByText('Blake will stop using it.')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(OLD_WORDS);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(erasePosts()).toHaveLength(0);

    await userEvent.click(within(noteRow()).getByRole('button'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove typed note' }));
    await screen.findByText('Your note removed.');
    expect(screen.queryByText('Your note')).toBeNull();
    expect(erasePosts()).toHaveLength(1);
    expect(erasePosts()[0].body).toEqual({ confirm: true, expectedPointerGeneration: expect.any(Number) });
    await waitFor(() => expect(screen.queryByText('Free parking behind the building')).toBeNull());
    expect(screen.getByRole('region', { name: 'Sources' }).textContent).not.toMatch(OLD_WORDS);
  });

  it('stays quiet while cleanup fails, then shows one notice with Try again, and the retry finishes it', async () => {
    sourceStoreErasers.push({ name: 'always_down', appliesTo: () => true, erase: async () => { throw new Error('store unavailable'); } });
    await openWithTypedNote(OWNER.retry);
    await userEvent.click(within(noteRow()).getByRole('button'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove typed note' }));
    await screen.findByText("Couldn't finish removing Your note.", {}, { timeout: 5000 });
    expect(screen.getByText('Blake has stopped using it.', { exact: false })).toBeTruthy();
    expect(screen.queryByText('Your note')).toBeNull();

    sourceStoreErasers.length = 0;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText("Couldn't finish removing Your note.")).toBeNull(), { timeout: 5000 });
    expect(erasePosts()).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Sources' }).textContent).not.toMatch(OLD_WORDS);
  });
});
