// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { accountExit } from '../../src/pages/owner/Account.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { asOwner } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';

// PO-S18 and PO-D12: the Delete account section and its confirmation dialog, against the real handler and database.
// Acceptance PO-T14 (browser part). Each test signs in as its own owner, because a success erases that owner.
configure({ asyncUtilTimeout: 5000 });

const PROFILE_COOKIES = ['fl_first_name', 'fl_last_name', 'fl_email'];
let harness; let browser; let leave;
beforeAll(async () => { harness = await createUiHarness({ owners: 4 }); });
afterAll(async () => { await harness?.pg.close(); });
afterEach(() => {
  browser?.restore(); resetOwnerApi(); leave?.mockRestore();
  for (const name of PROFILE_COOKIES) document.cookie = `${name}=; Max-Age=0; Path=/`;
});

const scopeOf = (owner) => asOwner(harness.pg, async () => (await harness.pg.query('SELECT state FROM ownership_scopes WHERE id = $1', [owner.scopeId])).rows[0] ?? null);
const deleteCalls = () => browser.calls.filter((call) => call.method === 'DELETE' && call.path === '/v1/me/account');

/** Opens the Account page as one owner, with sign-in's readable cookies, and opens the dialog. */
async function openDialog(owner) {
  resetOwnerApi();
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  leave = vi.spyOn(accountExit, 'leave').mockImplementation(() => {});
  document.cookie = 'fl_first_name=Zo%C3%AB; Path=/';
  document.cookie = 'fl_email=zoe%40example.com; Path=/';
  window.history.replaceState({}, '', '/app/account');
  render(<OwnerApp signIn={() => {}} />);
  const section = await screen.findByRole('region', { name: 'Delete account' });
  await userEvent.click(within(section).getByRole('button', { name: 'Delete account' }));
  return screen.getByRole('dialog', { name: 'Delete your account?' });
}

describe('Delete account dialog', () => {
  it('lists what is erased, focuses Cancel first, and enables the delete button only for DELETE', async () => {
    const owner = harness.owners[0];
    const dialog = await openDialog(owner);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'All your receptionists', 'Their call transcripts and summaries', 'What they know about your business', 'Your share links', 'The link between your Google sign-in and Frontline',
    ]);
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(dialog).toHaveTextContent('Feedback you already sent to the Frontline team is deleted on its own after 30 days.');
    const field = within(dialog).getByRole('textbox', { name: 'Type DELETE to confirm' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete account' });
    expect(confirm).toBeDisabled();
    await userEvent.type(field, 'delete');
    expect(confirm).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await userEvent.clear(field);
    await userEvent.type(field, 'DELET');
    expect(confirm).toBeDisabled();
    await userEvent.type(field, 'E');
    expect(confirm).toBeEnabled();
    // Cancel closes it with nothing sent, and the account is untouched.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteCalls()).toEqual([]);
    expect(await scopeOf(owner)).toEqual({ state: 'claimed' });
  });

  it('deletes the account, forgets the name and email in this browser, and leaves for the home page confirmation', async () => {
    const owner = harness.owners[1];
    const dialog = await openDialog(owner);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Type DELETE to confirm' }), 'DELETE');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith('/?account=deleted'));
    expect(deleteCalls()).toHaveLength(1);
    expect(PROFILE_COOKIES.filter((name) => document.cookie.includes(`${name}=`))).toEqual([]);
    // The server ended the session: the cookie it sent back clears fl_auth.
    expect(browser.jar.fl_auth).toBe('');
    await harness.app.idle();
    expect(await scopeOf(owner)).toBeNull();
  });

  it('shows an inline error when the request fails, changes nothing, and lets the owner try again', async () => {
    const owner = harness.owners[2];
    const dialog = await openDialog(owner);
    const inner = globalThis.fetch;
    let failures = 1;
    globalThis.fetch = async (input, init = {}) => {
      if (String(input).endsWith('/v1/me/account') && failures > 0) { failures -= 1; throw new TypeError('network down'); }
      return inner(input, init);
    };
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Type DELETE to confirm' }), 'DELETE');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't reach Frontline. Check your connection, then try again.");
    expect(leave).not.toHaveBeenCalled();
    expect(await scopeOf(owner)).toEqual({ state: 'claimed' });
    expect(screen.getByRole('region', { name: 'Account' })).toBeInTheDocument();
    const retry = within(dialog).getByRole('button', { name: 'Delete account' });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    await waitFor(() => expect(leave).toHaveBeenCalledWith('/?account=deleted'));
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the plain fallback sentence for a server failure', async () => {
    const owner = harness.owners[3];
    const dialog = await openDialog(owner);
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => (String(input).endsWith('/v1/me/account')
      ? new Response(JSON.stringify({ title: 'internal_error', detail: 'stack trace that must not show' }), { status: 500, headers: { 'content-type': 'application/json' } })
      : inner(input, init));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Type DELETE to confirm' }), 'DELETE');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't delete your account. Try again.");
    expect(dialog).not.toHaveTextContent('stack trace');
    expect(leave).not.toHaveBeenCalled();
  });
});
