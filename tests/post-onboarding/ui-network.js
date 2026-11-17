// Failure injection for browser tests. It wraps the browser-like fetch from `installBrowserFetch` and can drop a request
// before it reaches the app ("before") or let the app finish and then lose the response ("after", a lost response).
// Everything else still goes to the real handler and the real database.

/**
 * @param {{match: (path: string, method: string, search: string) => boolean, times?: number, mode: 'before'|'after'}} options
 * `times` is how many matching requests fail (default 1). `seen` lists every matching request with its headers.
 */
export function failRequests({ match, times = 1, mode }) {
  const inner = globalThis.fetch;
  const seen = /** @type {Array<{path: string, method: string, headers: Record<string, string>, failed: boolean}>} */ ([]);
  let remaining = times;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://frontline.test');
    const method = init.method ?? 'GET';
    if (!match(url.pathname, method, url.search)) return inner(input, init);
    const failed = remaining > 0;
    seen.push({ path: url.pathname + url.search, method, headers: { ...(init.headers ?? {}) }, failed });
    if (!failed) return inner(input, init);
    remaining -= 1;
    if (mode === 'before') return new Response(JSON.stringify({ title: 'unavailable', detail: 'down', status: 503 }), { status: 503, headers: { 'content-type': 'application/json' } });
    await inner(input, init);
    throw new TypeError('Failed to fetch');
  };
  return { seen, restore: () => { globalThis.fetch = inner; } };
}
