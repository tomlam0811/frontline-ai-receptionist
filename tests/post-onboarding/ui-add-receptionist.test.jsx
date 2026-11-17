// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { browserClient, fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';
import { deferred, watchRequests } from './ui-helpers.js';
import { addReceptionistByApi, failRequests, renameByApi } from './ui-add-receptionist-helpers.js';

// MR-J1, MR-S1, MR-S2, MR-T1, MR-T2, MR-T13: the Add receptionist button and dialog on Home, against the real handler and a
// real migrated Postgres. Each test has its own claimed owner, so the receptionists one test adds do not leak into another.
configure({ asyncUtilTimeout: 10000 });

let harness; let browser;
const OWNER = { bobTaken: 0, bobFree: 1, lowercase: 2, add: 3, retry: 4, taken: 5, invalid: 6, generic: 7, limit: 8, busy: 9, serverLimit: 10, cancel: 11, several: 12, changed: 13 };
beforeAll(async () => { harness = await createUiHarness({ owners: Object.keys(OWNER).length, handlerContext: { voice: fakeVoice() } }); });
afterEach(() => { cleanup(); browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });

const ownerFor = (name) => harness.owners[OWNER[name]];
const openHome = async (owner) => {
  resetOwnerApi();
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  window.history.replaceState({}, '', '/app');
  render(<OwnerApp signIn={() => {}} />);
  await screen.findAllByRole('link', { name: /^[^,]+, Riverside Dental/ });
};
const addButton = () => screen.getByRole('button', { name: 'Add receptionist' });
const openDialog = async () => { await userEvent.click(addButton()); return screen.findByRole('dialog', { name: 'Add receptionist' }); };
const nameField = (dialog) => within(dialog).getByRole('textbox', { name: 'Name' });
const posts = () => browser.calls.filter((call) => call.method === 'POST' && call.path === '/v1/me/agents');
const cardNames = () => within(screen.getByRole('region', { name: 'Receptionist' })).getAllByRole('link').map((card) => card.querySelector('strong').textContent);
const client = (owner) => browserClient(harness.app, owner.authToken);

describe('Add receptionist button and dialog (MR-S1, MR-S2)', () => {
  it('sits under the cards as a small secondary button and opens a dialog with the field focused and one sentence about what happens next', async () => {
    const owner = ownerFor('bobTaken');
    await openHome(owner);
    const section = screen.getByRole('region', { name: 'Receptionist' });
    const button = within(section).getByRole('button', { name: 'Add receptionist' });
    expect(button).toHaveClass('bob-button--secondary', 'bob-button--small');
    expect(button).toBeEnabled();
    // The cards come first, then the button.
    const lastCard = within(section).getAllByRole('link').at(-1);
    expect(lastCard.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const dialog = await openDialog();
    expect(within(dialog).getByText('It starts with the website you gave during setup. Change what it knows any time in Knowledge.')).toBeInTheDocument();
    expect(nameField(dialog)).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(posts()).toHaveLength(0);
  });

  it('leaves the field empty and Add disabled when a receptionist is already named Blake (MR-T2)', async () => {
    await openHome(ownerFor('bobTaken'));
    const dialog = await openDialog();
    expect(nameField(dialog)).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    await userEvent.type(nameField(dialog), 'Sam');
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('prefills Blake when no receptionist has that name (MR-T2)', async () => {
    const owner = ownerFor('bobFree');
    await renameByApi(harness, owner, owner.agentId, 'Sam');
    await openHome(owner);
    const dialog = await openDialog();
    expect(nameField(dialog)).toHaveValue('Blake');
    expect(nameField(dialog)).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('ignores case when it decides whether Blake is taken', async () => {
    const owner = ownerFor('lowercase');
    await renameByApi(harness, owner, owner.agentId, 'bLAKE');
    await openHome(owner);
    expect(cardNames()).toEqual(['bLAKE']);
    const dialog = await openDialog();
    expect(nameField(dialog)).toHaveValue('');
  });

  it('closes with Cancel or Escape and sends nothing, returning focus to the button', async () => {
    await openHome(ownerFor('cancel'));
    let dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(addButton()).toHaveFocus();
    dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(addButton()).toHaveFocus();
    expect(posts()).toHaveLength(0);
    expect(cardNames()).toEqual(['Blake']);
  });
});

describe('Adding a receptionist (MR-J1, MR-T1)', () => {
  it('sends one request with an idempotency key, opens the new receptionist and lists it on Home with the website selected', async () => {
    const owner = ownerFor('add');
    await openHome(owner);
    const watch = watchRequests();
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), '  Sam ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/app\/agents\/[0-9a-f-]{36}$/));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sam' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const created = watch.seen.filter((request) => request.method === 'POST' && request.path === '/v1/me/agents');
    expect(created).toHaveLength(1);
    expect(created[0].key).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(posts()[0].body).toEqual({ name: 'Sam' });
    const newId = window.location.pathname.split('/').at(-1);
    expect(newId).not.toBe(owner.agentId);
    expect(screen.getByRole('link', { name: 'Talk to Sam' })).toBeInTheDocument();
    watch.stop();

    // The new receptionist starts with the website given during onboarding, and Home lists both.
    const knowledge = await (await client(owner).request('GET', `/v1/agents/${newId}/knowledge`)).json();
    expect(knowledge.sourceIds).toEqual(['src-p1']);
    cleanup();
    await openHome(owner);
    expect(cardNames()).toEqual(['Blake', 'Sam']);
    const card = screen.getByRole('link', { name: 'Sam, Riverside Dental, active. View.' });
    expect(card).toHaveAttribute('href', `/app/agents/${newId}`);
    expect(within(card).getByText('Active')).toBeInTheDocument();
  });

  it('reuses the idempotency key when the owner retries a submit whose answer was lost, and adds one receptionist', async () => {
    const owner = ownerFor('retry');
    await openHome(owner);
    const watch = watchRequests({ dropResponseOnce: (request) => request.method === 'POST' && request.path === '/v1/me/agents' });
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't add the receptionist. Try again.");
    expect(nameField(dialog)).toHaveValue('Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/app\/agents\/[0-9a-f-]{36}$/));
    const created = watch.seen.filter((request) => request.method === 'POST' && request.path === '/v1/me/agents');
    expect(created).toHaveLength(2);
    expect(created[1].key).toBe(created[0].key);
    watch.stop();
    const agents = (await (await client(owner).request('GET', '/v1/me/agents')).json()).agents;
    expect(agents.map((agent) => agent.name)).toEqual(['Blake', 'Sam']);
  });

  it('uses a new key for a changed name after a failure', async () => {
    const owner = ownerFor('changed');
    await openHome(owner);
    const failing = failRequests({ match: (request) => request.method === 'POST' && request.path === '/v1/me/agents', times: 1 });
    const watch = watchRequests();
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await within(dialog).findByRole('alert');
    await userEvent.clear(nameField(dialog));
    await userEvent.type(nameField(dialog), 'Mia');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/app\/agents\/[0-9a-f-]{36}$/));
    const created = watch.seen.filter((request) => request.method === 'POST' && request.path === '/v1/me/agents');
    expect(created).toHaveLength(2);
    expect(created[1].key).not.toBe(created[0].key);
    watch.stop(); failing.stop();
  });

  it('shows the spinner on Add and keeps the dialog open until the server answers', async () => {
    const owner = ownerFor('busy');
    await openHome(owner);
    const held = deferred();
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (String(input).endsWith('/v1/me/agents') && init.method === 'POST') await held.promise;
      return inner(input, init);
    };
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    expect(add.querySelector('.owner-spinner')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(nameField(dialog)).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Add receptionist' })).toBeInTheDocument();
    held.resolve();
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/app\/agents\/[0-9a-f-]{36}$/));
    expect(posts()).toHaveLength(1);
  });
});

describe('Add receptionist failures', () => {
  it('says the name is already used, keeps the typed name and the dialog (name_taken)', async () => {
    await openHome(ownerFor('taken'));
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'BLAKE');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That name is already used.');
    expect(nameField(dialog)).toHaveValue('BLAKE');
    expect(nameField(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(cardNames()).toEqual(['Blake']);
    // Typing clears the message.
    await userEvent.type(nameField(dialog), 'x');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('checks the name before sending, and shows the same sentence when the server refuses it (invalid_name)', async () => {
    await openHome(ownerFor('invalid'));
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam 3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.');
    expect(posts()).toHaveLength(0);

    failRequests({ match: (request) => request.method === 'POST' && request.path === '/v1/me/agents', status: 422, title: 'invalid_name', detail: 'Name the new receptionist.', times: 1 });
    await userEvent.clear(nameField(dialog));
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.'));
    expect(nameField(dialog)).toHaveValue('Sam');
  });

  it('keeps the dialog with the typed name for any other failure, and a retry succeeds', async () => {
    await openHome(ownerFor('generic'));
    failRequests({ match: (request) => request.method === 'POST' && request.path === '/v1/me/agents', status: 500, times: 1 });
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't add the receptionist. Try again.");
    expect(nameField(dialog)).toHaveValue('Sam');
    expect(screen.getByRole('dialog', { name: 'Add receptionist' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/app');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/app\/agents\/[0-9a-f-]{36}$/));
  });

  it('shows the limit sentence when the server answers receptionist_limit', async () => {
    await openHome(ownerFor('serverLimit'));
    failRequests({ match: (request) => request.method === 'POST' && request.path === '/v1/me/agents', status: 409, title: 'receptionist_limit', detail: 'You can have up to 5 receptionists.', times: 1 });
    const dialog = await openDialog();
    await userEvent.type(nameField(dialog), 'Sam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You can have up to 5 receptionists.');
  });
});

describe('Several receptionists and the limit (MR-T13)', () => {
  it('lists every receptionist as its own card in the order added, each linking to its page', async () => {
    const owner = ownerFor('several');
    const made = [];
    for (const name of ['Zed', 'Amy']) made.push(await addReceptionistByApi(harness, owner, name));
    await openHome(owner);
    expect(cardNames()).toEqual(['Blake', 'Zed', 'Amy']);
    const links = within(screen.getByRole('region', { name: 'Receptionist' })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([`/app/agents/${owner.agentId}`, ...made.map((agent) => `/app/agents/${agent.stableAgentId}`)]);
    expect(links[0].parentElement).toHaveClass('owner-agent-list');
    expect(addButton()).toBeEnabled();
    expect(screen.queryByText('You can have up to 5 receptionists.')).not.toBeInTheDocument();
  });

  it('disables the button at 5 receptionists and shows the reason', async () => {
    const owner = ownerFor('limit');
    for (const name of ['Zed', 'Amy', 'Mia']) await addReceptionistByApi(harness, owner, name);
    await openHome(owner);
    expect(addButton()).toBeEnabled();
    cleanup(); browser.restore(); resetOwnerApi();
    await addReceptionistByApi(harness, owner, 'Kai');
    await openHome(owner);
    expect(cardNames()).toHaveLength(5);
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAccessibleDescription('You can have up to 5 receptionists.');
    expect(screen.getByText('You can have up to 5 receptionists.')).toBeVisible();
    await userEvent.click(addButton());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The API agrees.
    const refused = await client(owner).request('POST', '/v1/me/agents', { body: { name: 'Sixth' }, headers: { 'idempotency-key': 'sixth-key' } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).title).toBe('receptionist_limit');
  });
});
