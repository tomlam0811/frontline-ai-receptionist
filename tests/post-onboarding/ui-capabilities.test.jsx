// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OwnerApp from '../../src/pages/owner/OwnerApp.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';

// Capabilities (PO-S9) against the real handler and a real migrated Postgres. Four workflows are switches that save a new
// version. The three add-ons that are not built are labeled Coming soon and have no control.

let harness; let browser; let nextIndex = 0;
const nextOwner = () => harness.owners[nextIndex++];
afterEach(() => { browser?.restore(); resetOwnerApi(); });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ owners: 3, handlerContext: { voice: fakeVoice() } }); });

const open = async (owner) => {
  browser = installBrowserFetch({ app: harness.app, authToken: owner.authToken });
  window.history.replaceState({}, '', `/app/agents/${owner.agentId}/capabilities`);
  render(<OwnerApp signIn={() => {}} />);
  return owner;
};

describe('Capabilities', () => {
  it('lists four switches, all on by default, then three Coming soon add-ons with no control', async () => {
    const owner = await open(nextOwner());
    const list = await screen.findByRole('list', { name: 'What Blake can do' });
    expect(screen.getByRole('heading', { level: 1, name: 'Capabilities' })).toBeInTheDocument();
    expect(document.title).toBe('Capabilities · Frontline');
    expect(screen.getByText('Choose what Blake can do.')).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByRole('switch')).toHaveLength(4));
    expect(within(list).getAllByRole('switch').map((box) => box.getAttribute('aria-labelledby') && document.getElementById(box.getAttribute('aria-labelledby')).textContent))
      .toEqual(['Suggest services', 'Take service requests', 'Look up appointments', 'Save complaints']);
    for (const box of within(list).getAllByRole('switch')) expect(box).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('heading', { level: 2, name: 'Coming soon' })).toBeInTheDocument();
    const soon = screen.getByRole('list', { name: 'Coming soon for Blake' });
    expect(within(soon).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Email me each request', 'Hand off to a person', 'Reschedule or cancel appointments']);
    expect(within(soon).queryAllByRole('button')).toHaveLength(0);
    expect(within(soon).queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByRole('navigation', { name: 'Receptionist sections' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request another capability' })).toHaveAttribute('href', `/app/agents/${owner.agentId}/feedback?category=functionality`);
  });

  it('saves a change, shows Changes saved as untested, and the switch is still off after a fresh load', async () => {
    const owner = await open(nextOwner());
    await screen.findByRole('list', { name: 'What Blake can do' });
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(4));
    await userEvent.click(screen.getByRole('switch', { name: 'Save complaints' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const banner = await screen.findByRole('status', { name: 'Changes saved' });
    expect(within(banner).getByRole('heading', { name: 'Changes saved. Talk to Blake to hear them.' })).toBeInTheDocument();
    expect(browser.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    cleanup(); resetOwnerApi(); browser.restore();
    await open(owner);
    await screen.findByRole('list', { name: 'What Blake can do' });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Save complaints' })).not.toBeChecked());
    expect(screen.getByRole('switch', { name: 'Suggest services' })).toBeChecked();
  });

  it('turning a switch back to its saved value leaves nothing to save', async () => {
    await open(nextOwner());
    await screen.findByRole('list', { name: 'What Blake can do' });
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(4));
    await userEvent.click(screen.getByRole('switch', { name: 'Take service requests' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Take service requests' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(browser.calls.filter((call) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(call.method))).toHaveLength(0);
  });
});
