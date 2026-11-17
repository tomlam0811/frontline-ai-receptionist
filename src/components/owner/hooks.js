import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data once per `key` and exposes reload. State is 'loading' | 'ready' | 'error'.
 * The previous data stays available while a reload runs, so a screen never flashes empty.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} load
 * @param {unknown[]} deps
 */
export function useLoad(load, deps) {
  const [state, setState] = useState({ status: 'loading', data: /** @type {T|null} */ (null), error: null });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: current.data ? 'ready' : 'loading', error: null }));
    loader.current(controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted && error?.name !== 'AbortError') setState((current) => ({ ...current, status: 'error', error })); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}

/** Sets document.title to "[screen] · Frontline" and moves focus to the h1 once when the screen changes. */
export function usePageTitle(title, ready = true) {
  useEffect(() => { document.title = `${title} · Frontline`; }, [title]);
  useEffect(() => {
    if (!ready) return;
    const heading = document.querySelector('main h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); /** @type {HTMLElement} */ (heading).focus({ preventScroll: false }); }
  }, [title, ready]);
}

/** A draft kept in sessionStorage (design spec PO-DC11), restored after sign-in expiry. Storage failure is not an error. */
export function useDraft(key) {
  const read = () => { try { return window.sessionStorage.getItem(key) ?? ''; } catch { return ''; } };
  const [value, setValue] = useState(read);
  const [restored] = useState(() => read().length > 0);
  const update = useCallback((next) => {
    setValue(next);
    try { if (next) window.sessionStorage.setItem(key, next); else window.sessionStorage.removeItem(key); } catch { /* the draft simply is not kept */ }
  }, [key]);
  return { value, setValue: update, restored };
}
