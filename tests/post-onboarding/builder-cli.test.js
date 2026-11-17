import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, fileCredentialStore, runCli, startLoopbackListener } from '../../scripts/builder/lib/cli.mjs';
import { createMigratedDatabase } from './database.js';
import { browserClient, seedClaimedOwner, seedSession, startServer } from './fixtures.js';

let pg; let app; let owner; let builderClient; let store;
const apiUrl = 'http://frontline.test';
const memoryStore = () => { const saved = new Map(); return { read: async (url) => saved.get(url) ?? null, write: async (url, value) => { saved.set(url, value); }, remove: async (url) => { saved.delete(url); }, saved }; };

function harness(overrides = {}) {
  const out = []; const err = [];
  return {
    out, err,
    run: (argv, extra = {}) => runCli(argv, { env: { FRONTLINE_API_URL: apiUrl }, fetch: app.fetch, stdout: (line) => { out.push(line); }, stderr: (line) => { err.push(line); }, store, ...overrides, ...extra }),
  };
}

// The "browser" step of the login: the signed-in builder approves the CLI's challenge, and the
// approval page redirects to the CLI's loopback listener with the one-time code.
function approvingBrowser(listenerHolder) {
  return async (url) => {
    const query = new URL(url).searchParams;
    const approved = await (await builderClient.request('POST', '/v1/builder/credentials', { body: { challenge: query.get('challenge'), label: 'test' } })).json();
    listenerHolder.deliver(approved.code, query.get('state'));
    return true;
  };
}
function inMemoryListener(holder) {
  return async ({ expectedState }) => {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    holder.deliver = (code, state) => (state === expectedState ? resolve(code) : reject(new Error('state_mismatch')));
    return { port: 1, wait: () => promise, close() {} };
  };
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg);
  const builder = await seedSession(pg, { builder: true });
  await pg.exec('SET ROLE frontline_app');
  app = startServer(pg);
  builderClient = browserClient(app, builder.authToken);
  store = memoryStore();
  const ownerClient = browserClient(app, owner.authToken);
  for (const text of ['Blake missed the hours question', 'Blake was polite about pricing']) {
    await ownerClient.request('POST', `/v1/agents/${owner.agentId}/feedback`, { body: { category: 'quality', inputMethod: 'text', text }, headers: { 'idempotency-key': text.replace(/\W/g, '_') } });
  }
});
afterAll(async () => { await app?.close(); });

describe('frontline builder CLI', () => {
  it('logs in with PKCE through the API, stores a 0600-safe credential, and never prints the token', async () => {
    const holder = {}; const h = harness();
    const code = await h.run(['auth', 'login'], { listen: inMemoryListener(holder), openBrowser: approvingBrowser(holder) });
    expect(code).toBe(EXIT.ok);
    const saved = store.saved.get(apiUrl);
    expect(saved.token).toMatch(/^flb_/);
    expect(JSON.parse(h.out[0])).toMatchObject({ loggedIn: true, scope: 'feedback:read' });
    expect([...h.out, ...h.err].join('\n')).not.toContain(saved.token);
  });

  it('searches with --json, --jsonl and human output', async () => {
    const json = harness();
    expect(await json.run(['feedback', 'search', '--query', 'hours', '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(json.out[0]);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].submittedText).toContain('hours');

    const jsonl = harness();
    expect(await jsonl.run(['feedback', 'search', '--jsonl'])).toBe(EXIT.ok);
    expect(jsonl.out.length).toBe(3);
    expect(JSON.parse(jsonl.out.at(-1))).toEqual({ nextCursor: null });
    expect(JSON.parse(jsonl.out[0]).id).toBeTruthy();

    const human = harness();
    expect(await human.run(['feedback', 'search', '--limit', '1'])).toBe(EXIT.ok);
    expect(human.out[0]).toContain('quality');
    expect(human.out.at(-1)).toMatch(/^More: --cursor /);
  });

  it('pages with --cursor and exits 1 on an empty result only with --fail-empty', async () => {
    const first = harness();
    await first.run(['feedback', 'search', '--limit', '1', '--json']);
    const cursor = JSON.parse(first.out[0]).nextCursor;
    const second = harness();
    await second.run(['feedback', 'search', '--limit', '1', '--cursor', cursor, '--json']);
    expect(JSON.parse(second.out[0]).records[0].id).not.toBe(JSON.parse(first.out[0]).records[0].id);
    const empty = harness();
    expect(await empty.run(['feedback', 'search', '--query', 'zzzz', '--json'])).toBe(EXIT.ok);
    expect(await harness().run(['feedback', 'search', '--query', 'zzzz', '--json', '--fail-empty'])).toBe(EXIT.notFound);
  });

  it('gets one record and exits 1 when it does not exist', async () => {
    const list = harness();
    await list.run(['feedback', 'search', '--limit', '1', '--json']);
    const id = JSON.parse(list.out[0]).records[0].id;
    const got = harness();
    expect(await got.run(['feedback', 'get', id, '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(got.out[0])).toMatchObject({ id, events: [expect.objectContaining({ action: 'submitted' })] });
    expect(await harness().run(['feedback', 'get', '00000000-0000-4000-8000-000000000000', '--json'])).toBe(EXIT.notFound);
  });

  it('uses exit codes 2 for usage, 3 for auth and 4 for network', async () => {
    expect(await harness().run(['feedback', 'search', '--nope'])).toBe(EXIT.usage);
    expect(await harness().run(['feedback', 'search'], { env: {} })).toBe(EXIT.usage);
    expect(await harness().run(['what'])).toBe(EXIT.usage);
    expect(await harness().run(['feedback', 'search', '--category', 'nope'])).toBe(EXIT.usage);
    expect(await harness().run(['feedback', 'search'], { store: memoryStore() })).toBe(EXIT.auth);
    expect(await harness().run(['feedback', 'search'], { fetch: async () => { throw new Error('ECONNREFUSED'); } })).toBe(EXIT.network);
    const badToken = harness();
    expect(await badToken.run(['feedback', 'search'], { env: { FRONTLINE_API_URL: apiUrl, FRONTLINE_BUILDER_TOKEN: `flb_${'a'.repeat(43)}` } })).toBe(EXIT.auth);
  });

  it('fails the login when the callback state does not match', async () => {
    const holder = {}; const h = harness({ store: memoryStore() });
    const code = await h.run(['auth', 'login'], { listen: inMemoryListener(holder), openBrowser: async () => { holder.deliver('whatever', 'wrong-state'); return true; } });
    expect(code).toBe(EXIT.auth);
  });

  it('logout revokes the credential on the server and forgets it locally', async () => {
    const token = store.saved.get(apiUrl).token;
    const h = harness();
    expect(await h.run(['auth', 'logout'])).toBe(EXIT.ok);
    expect(store.saved.has(apiUrl)).toBe(false);
    const after = await harness().run(['feedback', 'search'], { env: { FRONTLINE_API_URL: apiUrl, FRONTLINE_BUILDER_TOKEN: token } });
    expect(after).toBe(EXIT.auth);
  });
});

describe('credential file store', () => {
  it('writes the credential file with mode 0600 and removes it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'flb-'));
    const file = path.join(dir, 'nested', 'credentials.json');
    const files = fileCredentialStore(file);
    await files.write('https://api.test', { token: `flb_${'b'.repeat(43)}`, expiresAt: '2030-01-01T00:00:00Z' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))['https://api.test'].token).toMatch(/^flb_/);
    expect(await files.read('https://api.test')).toMatchObject({ expiresAt: '2030-01-01T00:00:00Z' });
    await files.remove('https://api.test');
    expect(await files.read('https://api.test')).toBeNull();
  });
});

describe('loopback listener', () => {
  it('reports a failed bind as a clean login failure', async () => {
    const h = harness({ store: memoryStore() });
    expect(await h.run(['auth', 'login'], { listen: async () => { throw new Error('EPERM'); } })).toBe(EXIT.auth);
    expect(h.err.join(' ')).toContain('local login listener');
  });

  it('accepts the callback only with the expected state (skipped where the environment forbids binding ports)', async (context) => {
    let listener;
    try { listener = await startLoopbackListener({ expectedState: 'abc', timeoutMs: 5000 }); }
    catch (error) { if (error?.code === 'EPERM') context.skip(); throw error; }
    // A failed bind must surface as a rejection the CLI can report, not an uncaught error.
    // Attach the rejection expectation before the request, so the rejection is never left unhandled.
    const rejected = expect(listener.wait()).rejects.toThrow('state_mismatch');
    expect((await fetch(`http://127.0.0.1:${listener.port}/callback?code=x&state=nope`)).status).toBe(400);
    await rejected;
  });
});
