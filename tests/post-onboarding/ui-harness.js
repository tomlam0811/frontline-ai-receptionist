import { hex64, seedClaimedOwner, startServer } from './fixtures.js';
import { createMigratedDatabase } from './database.js';

// The in-process Postgres loads its files through Node's File and Blob. jsdom's versions have no arrayBuffer(),
// so they are swapped for Node's only while the database starts.
async function migratedDatabaseInJsdom() {
  const { File: NodeFile, Blob: NodeBlob } = await import('node:buffer');
  const saved = { File: globalThis.File, Blob: globalThis.Blob };
  globalThis.File = /** @type {any} */ (NodeFile);
  globalThis.Blob = /** @type {any} */ (NodeBlob);
  try { return await createMigratedDatabase(); } finally { Object.assign(globalThis, saved); }
}

/**
 * Browser tests against the real thing: the real request handler on a real migrated Postgres, reached
 * through `window.fetch` (no socket, no mock adapter). Only the paid providers are replaced: pass `voice`
 * and `extraction` to the handler as needed.
 */
export async function createUiHarness({ handlerContext = {}, owners = 1, researched = true } = {}) {
  const pg = await migratedDatabaseInJsdom();
  const seeded = [];
  for (let index = 0; index < owners; index += 1) seeded.push(await seedClaimedOwner(pg, { researched }));
  await pg.exec('SET ROLE frontline_app');
  const app = startServer(pg, { limits: { ownerWrite: 100_000, ownerRead: 100_000 }, ...handlerContext });
  return { pg, app, owners: seeded, owner: seeded[0] };
}

/**
 * Replaces window.fetch with one that behaves like a browser talking to the app: it keeps a cookie jar
 * (fl_auth for a signed-in owner, fl_csrf, fl_guest from Set-Cookie) and serves /v1/session like the real one.
 * Returns { restore, jar, calls } where calls lists every request the page made.
 * @param {{app: any, authToken?: string|null}} options
 */
export function installBrowserFetch({ app, authToken = null }) {
  const csrf = hex64();
  const jar = { fl_csrf: csrf, ...(authToken ? { fl_auth: authToken } : {}) };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), app.baseUrl);
    if (url.pathname === '/v1/session') return new Response(JSON.stringify({ csrfToken: csrf }), { status: 200, headers: { 'content-type': 'application/json' } });
    const headers = { ...(init.headers ?? {}), origin: app.baseUrl, cookie: Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ') };
    calls.push({ method: init.method ?? 'GET', path: url.pathname + url.search, body: init.body ? JSON.parse(init.body) : undefined });
    const response = await app.fetch(url.href, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) { const [pair] = setCookie.split(';'); const [name, value] = pair.split('='); jar[name] = value; }
    return response;
  };
  return { jar, calls, restore: () => { globalThis.fetch = original; } };
}
