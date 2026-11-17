import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, it, expect, vi } from 'vitest';
import App from '../src/App.jsx';
import Landing from '../src/pages/Landing.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

// The landing page has a website form near the top and another at the bottom. Both share one value.
const websiteInput = () => screen.getAllByRole('textbox', { name: /business website/i })[0];

const preparationId = '11111111-1111-4111-8111-111111111111';
const preparedBusiness = {
  preparationId,
  state: 'ready',
  readiness: 'ready',
  revision: 1,
  profile: {
    businessName: 'Example Cleaning',
    services: [{ name: 'Apartment cleaning', sourceUrl: 'https://example.com/services' }],
    hours: null,
  },
  capabilityManifest: {
    knowledgeCoverage: 'partial',
    actionReadiness: 'intake_only',
    capabilities: [{ topic: 'Service questions', canDoNow: 'Explain the sourced cleaning services' }],
  },
  availableModes: ['business_demo'],
  gaps: ['hours_unknown'],
};

/** @param {unknown} body */
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * @typedef {(options: RequestInit) => ReturnType<typeof response> | Promise<ReturnType<typeof response>>} PreparationResponder
 */

/** @param {{ create?: PreparationResponder, get?: PreparationResponder }} [handlers] */
function mockPreparationApi({ create = () => response({ preparationId }, 202), get = () => response(preparedBusiness) } = {}) {
  const fetchMock = vi.fn(/** @param {string} path @param {RequestInit} [options] */ async (path, options = {}) => {
    if (path === '/v1/session') return response({ csrfToken: 'test-csrf-token' });
    if (path === '/v1/preparations') return create(options);
    if (path === `/v1/preparations/${preparationId}`) return get(options);
    throw new Error(`Unexpected API request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it('keeps a real website action and removes the public fixed sample', () => {
  render(<App />);
  const hero = screen.getByRole('region', { name: /miss fewer.*customer calls/i });
  expect(within(hero).getByRole('textbox', { name: /business website/i })).toBeInTheDocument();
  expect(within(hero).getByRole('button', { name: /^try blake/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Frontline home' })).toHaveAttribute('href', '/');
  for (const link of screen.getAllByRole('link', { name: /try blake/i })) expect(link).toHaveAttribute('href', '#website');
  expect(screen.queryByText(/i don’t have a website|see the handoff|guided example/i)).not.toBeInTheDocument();
});

it('tells the landing story in order: problem, what Blake does, setup, control, then a closing form', () => {
  render(<App />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
  expect(headings).toEqual([
    'Work keeps you away from the phone',
    'How Blake handles a call',
    'Set up Blake in four steps',
    'Stay in control',
    'Hear Blake answer for your business',
  ]);
  const setup = screen.getByRole('region', { name: 'Set up Blake in four steps' });
  expect(within(setup).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
    'Add your website', 'Talk to Blake', 'Save Blake', 'Teach Blake more',
  ]);
  expect(within(setup).getByText(/ready to talk and share/i)).toBeInTheDocument();
});

it('names why the owner cannot answer, then says what it costs, without repeating the headline', () => {
  render(<App />);
  const pain = screen.getByRole('region', { name: 'Work keeps you away from the phone' });
  expect(within(pain).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
    'With a customer', 'On the road', 'On the job',
  ]);
  expect(within(pain).getByText(/reach voicemail often try the next business/i)).toBeInTheDocument();
  expect(document.body.textContent.match(/customer calls/gi)).toHaveLength(1);
  expect(screen.getByText(/answers customer questions from your website/i)).toBeInTheDocument();
  for (const heading of Array.from(document.querySelectorAll('h1, h2, h3'))) expect(heading.textContent).not.toMatch(/[.!?]$/);
});

it('keeps the header to the logo, Sign in and Try Blake, with no section links', () => {
  render(<App />);
  const header = screen.getByRole('banner');
  expect(within(header).getAllByRole('link').map((link) => link.textContent)).toEqual(['Frontline', 'Sign in', 'Try Blake']);
});

it('shows no invented customer data and no claims the product does not make', () => {
  render(<App />);
  const page = document.body.textContent;
  expect(page).not.toMatch(/example of a saved request|sound familiar|wrong time|maria|lopez|555-|riverside|furnace not heating|pilot light/i);
  expect(page).not.toMatch(/testimonial|customer reviews|star rating|\d+ ?%|\$\d|per month|free trial/i);
  expect(page).not.toMatch(/every call|never miss|forward|\b(?:goes|is|went) live\b|books? appointments/i);
  expect(page).not.toMatch(/\b(agent|assistant|front desk|workspace|handoff|capture|grounded|compile|business context)\b/i);
  expect(page).not.toContain('\u2014');
  expect(page.match(/AI receptionist/g)).toHaveLength(1);
  expect(page).toContain('Contact the Frontline team from Blake\u2019s page to set up your phone number.'.replace('\u2019', "'"));
});

it('marks the product screens as pictures and gives them nothing to click', () => {
  render(<App />);
  const screens = document.querySelectorAll('.sc');
  expect(screens.length).toBeGreaterThanOrEqual(8);
  for (const scene of Array.from(screens)) {
    expect(scene).toHaveAttribute('aria-hidden', 'true');
    expect(scene.querySelector('button, a, input, textarea, select')).toBeNull();
  }
});

it('submits the same website from the hero or the closing form and shows errors only where they were typed', async () => {
  const onPrepare = vi.fn();
  render(<Landing onPrepare={onPrepare} initialWebsite="" />);
  const [heroInput, closingInput] = screen.getAllByRole('textbox', { name: /business website/i });
  expect(heroInput.id).not.toBe(closingInput.id);
  const [heroButton, closingButton] = screen.getAllByRole('button', { name: /^try blake/i });

  await userEvent.click(closingButton);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(closingInput).toHaveAttribute('aria-invalid', 'true');
  expect(heroInput).toHaveAttribute('aria-invalid', 'false');
  expect(onPrepare).not.toHaveBeenCalled();

  await userEvent.type(heroInput, 'example.com');
  expect(closingInput).toHaveValue('example.com');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await userEvent.click(heroButton);
  expect(onPrepare).toHaveBeenCalledWith('https://example.com/');
  onPrepare.mockClear();
  await userEvent.click(closingButton);
  expect(onPrepare).toHaveBeenCalledWith('https://example.com/');
});

it('shows a sign-in error above the hero form and keeps the typed website', () => {
  render(<Landing onPrepare={vi.fn()} initialWebsite="mybusiness.example" signInError="Sign-in didn't finish. Try again." />);
  expect(screen.getByRole('alert')).toHaveTextContent("Sign-in didn't finish. Try again.");
  expect(screen.getAllByRole('textbox', { name: /business website/i })[0]).toHaveValue('mybusiness.example');
});

it('confirms a deleted account once on the public home page and removes the marker from the address (PO-T14)', async () => {
  window.history.replaceState({}, '', '/?account=deleted#top');
  const view = render(<Landing onPrepare={vi.fn()} initialWebsite="" />);
  expect(await screen.findByRole('status')).toHaveTextContent('Your account was deleted.');
  expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/#top');
  view.unmount();
  render(<Landing onPrepare={vi.fn()} initialWebsite="" />);
  expect(screen.queryByText(/Your account was deleted/)).not.toBeInTheDocument();
});

it('validates the public website URL before making a request', async () => {
  render(<App />);
  const hero = screen.getByRole('region', { name: /miss fewer.*customer calls/i });
  await userEvent.click(within(hero).getByRole('button', { name: /^try blake/i }));
  expect(within(hero).getByRole('alert')).toHaveTextContent(/type your website/i);
  await userEvent.type(within(hero).getByRole('textbox', { name: /business website/i }), 'not a url');
  await userEvent.click(within(hero).getByRole('button', { name: /^try blake/i }));
  expect(within(hero).getByRole('alert')).toHaveTextContent(/type your website/i);
});

it('shows the sourced profile returned by the scoped preparation API', async () => {
  const fetchMock = mockPreparationApi();
  render(<App />);
  await userEvent.type(websiteInput(), 'example.com{Enter}');
  expect(await screen.findByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
  expect(screen.getByText('Example Cleaning')).toBeInTheDocument();
  expect(screen.getByText(/ready to help with things like apartment cleaning/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Talk to Blake' })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledWith('/v1/preparations', expect.objectContaining({
    method: 'POST', credentials: 'include', body: JSON.stringify({ url: 'https://example.com/' }),
    headers: expect.objectContaining({ 'X-Frontline-CSRF': 'test-csrf-token', 'Content-Type': 'application/json' }),
  }));
  expect(fetchMock).toHaveBeenCalledWith(`/v1/preparations/${preparationId}`, expect.objectContaining({ method: 'GET', credentials: 'include' }));
  expect(window.sessionStorage.getItem('frontline.preparationId')).toBe(preparationId);
  expect(screen.queryByRole('heading', { name: /see how preparation would work/i })).not.toBeInTheDocument();
});

it('uses a trial URL and links the product wordmark to the homepage', async () => {
  mockPreparationApi();
  render(<App />);
  await userEvent.type(websiteInput(), 'example.com{Enter}');
  expect(await screen.findByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/try/meet-bob');
  expect(screen.getByRole('link', { name: 'Frontline home' })).toHaveAttribute('href', '/');
});

it('shows the homepage at its own URL even when a prior trial can be resumed', () => {
  window.sessionStorage.setItem('frontline.preparationId', preparationId);
  const fetchMock = mockPreparationApi();
  render(<App />);
  expect(websiteInput()).toBeInTheDocument();
  expect(window.location.pathname).toBe('/');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('restores a saved trial from its sub URL', async () => {
  window.sessionStorage.setItem('frontline.preparationId', preparationId);
  window.history.replaceState({}, '', '/try/meet-bob');
  const fetchMock = mockPreparationApi();
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/try/meet-bob');
  expect(fetchMock).toHaveBeenCalledWith('/v1/preparations/' + preparationId, expect.objectContaining({ method: 'GET', credentials: 'include' }));
});

it('ends an active saved call before showing a result after refresh', async () => {
  const demoId = '22222222-2222-4222-8222-222222222222';
  window.sessionStorage.setItem('frontline.preparationId', preparationId);
  window.sessionStorage.setItem('frontline.demoId', demoId);
  window.history.replaceState({}, '', '/try/conversation');
  let ended = false;
  const fetchMock = vi.fn(async (path) => {
    if (path === '/v1/session') return response({ csrfToken: 'test-csrf-token' });
    if (path === '/v1/preparations/' + preparationId) return response(preparedBusiness);
    if (path === '/v1/demos/' + demoId + '/result') return response({ demoId, state: ended ? 'ended' : 'active', mode: 'business_demo', requests: [], cases: [], lookups: [], receipts: [] });
    if (path === '/v1/demos/' + demoId + '/end') { ended = true; return response({ demoId, state: 'ended' }); }
    throw new Error('Unexpected API request: ' + path);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Call result' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/v1/demos/' + demoId + '/end', expect.objectContaining({ method: 'POST' }));
  expect(window.location.pathname).toBe('/try/result');
});

it('aborts preparation and ignores its late response after the visitor changes the website', async () => {
  /** @type {(result: ReturnType<typeof response>) => void} */
  let finishRequest;
  /** @type {AbortSignal | null | undefined} */
  let requestSignal;
  const fetchMock = mockPreparationApi({ create: ({ signal }) => {
    requestSignal = signal;
    return new Promise((resolve) => { finishRequest = resolve; });
  } });
  render(<App />);
  await userEvent.type(websiteInput(), 'first.example.org{Enter}');
  await waitFor(() => expect(finishRequest).toBeTypeOf('function'));
  await userEvent.click(screen.getByRole('button', { name: 'Change website' }));
  const website = websiteInput();
  expect(website).toHaveValue('https://first.example.org/');
  await userEvent.clear(website);
  await userEvent.type(website, 'second.example.org');
  await act(async () => {
    finishRequest(response({ preparationId }, 202));
  });
  expect(requestSignal?.aborted).toBe(true);
  expect(fetchMock).not.toHaveBeenCalledWith(`/v1/preparations/${preparationId}`, expect.anything());
  expect(window.sessionStorage.getItem('frontline.preparationId')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Meet Blake' })).not.toBeInTheDocument();
  expect(website).toHaveValue('second.example.org');
});

it('explains a preparation failure and lets the visitor retry the same website', async () => {
  const create = vi.fn()
    .mockResolvedValueOnce(response({ title: 'fetch_failed', detail: 'This website could not be reached.' }, 502))
    .mockResolvedValueOnce(response({ preparationId }, 202));
  mockPreparationApi({ create });
  render(<App />);
  await userEvent.type(websiteInput(), 'example.com{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('This website could not be reached.');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls.map(([options]) => JSON.parse(options.body))).toEqual([
    { url: 'https://example.com/' }, { url: 'https://example.com/' },
  ]);
});

it('keeps review controls separate and exposes recovery states', async () => {
  window.history.replaceState({}, '', '/?review');
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /review mode/i }));
  await userEvent.selectOptions(screen.getByLabelText(/journey screen/i), 'S9');
  await userEvent.click(screen.getByRole('radio', { name: 'provisioning failure' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/activation not confirmed/i);
  expect(screen.getByRole('button', { name: /retry activation example/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /view example agent home/i })).not.toBeInTheDocument();
});

it('keeps the scripted call details and product close connected to the sample result', async () => {
  window.history.replaceState({}, '', '/?review');
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /review mode/i }));
  await userEvent.selectOptions(screen.getByLabelText(/journey screen/i), 'S5');
  expect(screen.getByText(/i’m jordan lee at 1452 ne alberta st/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /finish example/i }));
  expect(screen.getByText(/thanks for trying frontline/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /view sample request/i }));
  expect(screen.getByText(/jordan lee · sample/i)).toBeInTheDocument();
  expect(screen.getByText(/1452 ne alberta st · sample/i)).toBeInTheDocument();
});

it('returns an incomplete activation to setup for recovery', async () => {
  window.history.replaceState({}, '', '/?review');
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /review mode/i }));
  await userEvent.selectOptions(screen.getByLabelText(/journey screen/i), 'S10');
  await userEvent.click(screen.getByRole('radio', { name: /provisioning issue/i }));
  await userEvent.click(screen.getByRole('button', { name: /return to setup/i }));
  expect(screen.getByRole('alert')).toHaveTextContent(/activation not confirmed/i);
  expect(screen.getByRole('button', { name: /retry activation example/i })).toBeInTheDocument();
});

it('keeps the entered website when an internal review preparation fails and the reviewer goes back', async () => {
  window.history.replaceState({}, '', '/?review');
  render(<App />);
  await userEvent.type(websiteInput(), 'mybusiness.example');
  await userEvent.click(screen.getByRole('button', { name: /explore the sample/i }));
  await userEvent.click(screen.getByRole('button', { name: /review mode/i }));
  await userEvent.click(screen.getByRole('radio', { name: 'error' }));
  await userEvent.click(screen.getByRole('button', { name: /check website field/i }));
  expect(websiteInput()).toHaveValue('mybusiness.example');
});

it('does not claim a callback was collected when the sample ends early', async () => {
  window.history.replaceState({}, '', '/?review');
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /review mode/i }));
  await userEvent.selectOptions(screen.getByLabelText(/journey screen/i), 'S5');
  await userEvent.click(screen.getByRole('radio', { name: 'reconnect' }));
  expect(screen.queryByText(/you can call me at/i)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /view partial sample result/i }));
  expect(screen.getByText('Callback').parentElement).toHaveTextContent('Not collected');
});

it('keeps the partial outcome when finishing a reconnecting sample through the close', async () => {
  window.history.replaceState({}, '', '/?review');
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /review mode/i }));
  await userEvent.selectOptions(screen.getByLabelText(/journey screen/i), 'S5');
  await userEvent.click(screen.getByRole('radio', { name: 'reconnect' }));
  await userEvent.click(screen.getByRole('button', { name: /finish example/i }));
  await userEvent.click(screen.getByRole('button', { name: /view sample request/i }));
  expect(screen.getByText('Callback').parentElement).toHaveTextContent('Not collected');
});
