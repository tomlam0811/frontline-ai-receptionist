import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// scripts/prerender-landing.mjs bakes the rendered Landing page into the one dist/index.html
// that every route's SPA fallback serves, so document.getElementById('root') has child nodes
// on every route, not only on Landing ('/'). src/main.jsx must hydrate only against the route
// that was actually prerendered, and mount fresh (after clearing that stale markup) everywhere else.

const SHARE_PATH = '/app/agents/11111111-1111-4111-8111-111111111111/share';

function setRootMarkup(html) {
  document.body.innerHTML = `<div id="root">${html}</div>`;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('react-dom/client');
  vi.doUnmock('../src/App.jsx');
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

it('hydrates the prerendered markup on the landing route (/)', async () => {
  window.history.replaceState({}, '', '/');
  setRootMarkup('<div class="landing">Landing</div>');
  const hydrateRoot = vi.fn((/** @type {Element} */ _container) => {});
  const createRoot = vi.fn((/** @type {Element} */ _container) => ({ render: vi.fn() }));
  vi.doMock('react-dom/client', () => ({ hydrateRoot, createRoot }));
  vi.doMock('../src/App.jsx', () => ({ default: () => null }));

  await import('../src/main.jsx');

  const root = document.getElementById('root');
  expect(hydrateRoot).toHaveBeenCalledTimes(1);
  expect(hydrateRoot.mock.calls[0][0]).toBe(root);
  expect(createRoot).not.toHaveBeenCalled();
  // Hydration must run against the untouched prerendered markup.
  expect(root.innerHTML).toBe('<div class="landing">Landing</div>');
});

it('clears the stale prerendered markup and mounts fresh on a non-landing route', async () => {
  window.history.replaceState({}, '', SHARE_PATH);
  setRootMarkup('<div class="landing">Landing</div>');
  const hydrateRoot = vi.fn((/** @type {Element} */ _container) => {});
  const createRoot = vi.fn((/** @type {Element} */ _container) => ({ render: vi.fn() }));
  vi.doMock('react-dom/client', () => ({ hydrateRoot, createRoot }));
  vi.doMock('../src/App.jsx', () => ({ default: () => null }));

  await import('../src/main.jsx');

  const root = document.getElementById('root');
  expect(hydrateRoot).not.toHaveBeenCalled();
  expect(createRoot).toHaveBeenCalledTimes(1);
  expect(createRoot.mock.calls[0][0]).toBe(root);
  // The Landing markup must be gone before the fresh root mounts, not left sitting alongside it.
  expect(root.children).toHaveLength(0);
});
