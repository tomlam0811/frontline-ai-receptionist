import { afterEach } from 'vitest';

// Browser-side tests run in jsdom and talk to the real handler over an injected fetch (ui-harness.js).
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  Object.defineProperty(window, 'scrollTo', { value: () => {}, writable: true });
  afterEach(() => { cleanup(); window.sessionStorage.clear(); window.history.replaceState({}, '', '/'); });
}
