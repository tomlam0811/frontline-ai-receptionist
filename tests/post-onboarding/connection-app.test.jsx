// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/App.jsx';
import { resetOwnerApi } from '../../src/lib/owner-api.js';
import { fakeVoice } from './fixtures.js';
import { createUiHarness, installBrowserFetch } from './ui-harness.js';

// PO-C13: the app mounts the owner screens only when the build enables them, and a claim leads there.
// The owner screens talk to the real handler on real Postgres. Google sign-in is not available in tests, so the
// two claim endpoints are answered by the test (the claim itself is proven by the API suites); everything else
// goes to the real handler.

const FLAG = 'VITE_FRONTLINE_POST_ONBOARDING';
const DEMO_ID = '11111111-1111-4111-8111-111111111111';
const PHONE_COPY = /phone activation|no active number|activation/i;

let harness; let browser;
afterEach(() => { browser?.restore(); resetOwnerApi(); vi.unstubAllEnvs(); });
afterAll(async () => { await harness?.pg.close(); });
beforeAll(async () => { harness = await createUiHarness({ handlerContext: { voice: fakeVoice() } }); });

const openAt = (path) => {
  browser = installBrowserFetch({ app: harness.app, authToken: harness.owner.authToken });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), harness.app.baseUrl);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/claim-intents') return json({ claimIntentId: DEMO_ID, claimable: true });
    if (url.pathname === '/v1/claims') return json({ state: 'claimed', kind: 'agent', agentId: harness.owner.agentId }, 201);
    return realFetch(input, init);
  };
  const restoreClaimStub = browser.restore;
  browser.restore = () => { globalThis.fetch = realFetch; restoreClaimStub(); };
  window.history.replaceState({}, '', path);
  return render(<App />);
};

const returnFromGoogle = () => {
  window.sessionStorage.setItem('frontline.demoId', DEMO_ID);
  window.sessionStorage.setItem('frontline.saveStep', 'claim');
  window.sessionStorage.setItem('frontline.saveMode', 'business_demo');
  return openAt('/try/claim?auth=google-complete');
};

describe('Owner routes (PO-C13), flag on', () => {
  it('mounts Home for /app', async () => {
    vi.stubEnv(FLAG, 'on');
    await openAt('/app');
    expect(await screen.findByRole('link', { name: 'Blake, Riverside Dental, active. View.' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(PHONE_COPY);
  });

  it('offers additional info (v3 S13) after a finished claim, then leads to the first-visit screen', async () => {
    vi.stubEnv(FLAG, 'on');
    await returnFromGoogle();
    expect(await screen.findByRole('heading', { name: 'Anything else Blake should know?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('heading', { name: 'How was the conversation with Blake?' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/app/agents/${harness.owner.agentId}/welcome`);
    expect(document.body.textContent).not.toMatch(PHONE_COPY);
  });

  it('keeps the existing setup route on the current setup screen', async () => {
    vi.stubEnv(FLAG, 'on');
    await openAt(`/app/agents/${harness.owner.agentId}/setup`);
    await waitFor(() => expect(document.querySelector('.setup-page')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: 'Receptionist' })).toBeNull();
    expect(window.location.pathname).toBe(`/app/agents/${harness.owner.agentId}/setup`);
  });

  it('mounts the guest page for /shared', async () => {
    vi.stubEnv(FLAG, 'on');
    await openAt('/shared');
    await waitFor(() => expect(document.querySelector('.owner-shell')).not.toBeNull());
  });
});

describe('Owner routes (PO-C13), flag off', () => {
  it('leaves the current destination after a claim: the setup route, not the owner screens', async () => {
    await returnFromGoogle();
    await waitFor(() => expect(window.location.pathname).toBe(`/app/agents/${harness.owner.agentId}/setup`));
    expect(screen.queryByRole('heading', { name: 'How was the conversation with Blake?' })).toBeNull();
  });

  it('does not mount Home for /app', async () => {
    await openAt('/app');
    await waitFor(() => expect(document.querySelector('.landing')).not.toBeNull());
    expect(document.querySelector('.owner-shell')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Blake, Riverside Dental, active. View.' })).toBeNull();
  });
});
