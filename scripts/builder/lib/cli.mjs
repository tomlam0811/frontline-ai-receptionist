import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const EXIT = { ok: 0, notFound: 1, usage: 2, auth: 3, network: 4 };
const USAGE = `Usage:
  frontline auth login | logout
  frontline feedback search [--query q] [--category c] [--agent-id id] [--agent-version-id id]
                            [--conversation-id id] [--source owner|guest] [--status new|reviewed|resolved]
                            [--since iso] [--limit n] [--cursor c] [--json | --jsonl] [--fail-empty]
  frontline feedback get <id> [--json]
Environment: FRONTLINE_API_URL (required), FRONTLINE_BUILDER_TOKEN (optional, overrides the saved login).`;

const TOKEN = /^flb_[A-Za-z0-9_-]{43}$/;

/** Credential file with mode 0600 in the user's config directory. The token is never put in argv. */
export function fileCredentialStore(file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'frontline', 'credentials.json')) {
  return {
    async read(apiUrl) {
      try { const all = JSON.parse(await readFile(file, 'utf8')); return all[apiUrl] ?? null; } catch { return null; }
    },
    async write(apiUrl, credential) {
      let all = {};
      try { all = JSON.parse(await readFile(file, 'utf8')); } catch { /* first login */ }
      all[apiUrl] = credential;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(all), { mode: 0o600 });
      await chmod(file, 0o600);
    },
    async remove(apiUrl) {
      try {
        const all = JSON.parse(await readFile(file, 'utf8'));
        delete all[apiUrl];
        if (Object.keys(all).length) await writeFile(file, JSON.stringify(all), { mode: 0o600 }); else await rm(file);
      } catch { /* nothing saved */ }
    },
  };
}

/** Starts the loopback listener for the PKCE login and resolves with {port, wait()}. */
export async function startLoopbackListener({ expectedState, timeoutMs = 300_000 }) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const code = url.searchParams.get('code');
    const okState = url.searchParams.get('state') === expectedState;
    response.writeHead(okState && code ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(okState && code ? 'Frontline builder login complete. You can close this tab.' : 'Login failed. Return to the terminal.');
    if (okState && code) settle.resolve(code); else settle.reject(new Error('state_mismatch'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const timer = setTimeout(() => settle.reject(new Error('login_timeout')), timeoutMs);
  return {
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
    wait: () => result.finally(() => { clearTimeout(timer); server.close(); }),
    close: () => { clearTimeout(timer); server.close(); },
  };
}

function humanLine(record) {
  const text = record.submittedText.replace(/\s+/g, ' ');
  return `${record.createdAt}  ${record.status.padEnd(8)} ${record.category.padEnd(16)} ${record.source.padEnd(5)} ${record.id}  ${text.length > 100 ? `${text.slice(0, 97)}...` : text}`;
}

/**
 * Runs the CLI. Everything with a side effect is injectable so tests use real HTTP but
 * no browser and no home directory.
 */
export async function runCli(argv, {
  env = process.env, fetch: fetchImpl = fetch, stdout = (line) => { process.stdout.write(`${line}\n`); }, stderr = (line) => { process.stderr.write(`${line}\n`); },
  store = fileCredentialStore(), openBrowser = async (_url) => false, listen = startLoopbackListener,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      query: { type: 'string' }, category: { type: 'string' }, 'agent-id': { type: 'string' }, 'agent-version-id': { type: 'string' },
      'conversation-id': { type: 'string' }, source: { type: 'string' }, status: { type: 'string' }, since: { type: 'string' },
      limit: { type: 'string' }, cursor: { type: 'string' }, json: { type: 'boolean' }, jsonl: { type: 'boolean' }, 'fail-empty': { type: 'boolean' },
    } });
  } catch (error) { stderr(`${error.message}\n${USAGE}`); return EXIT.usage; }
  const { values, positionals } = parsed;
  const [group, action, target] = positionals;
  const apiUrl = (env.FRONTLINE_API_URL ?? '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(apiUrl)) { stderr(`FRONTLINE_API_URL is required.\n${USAGE}`); return EXIT.usage; }

  /** @param {string} method @param {string} pathAndQuery @param {{token?: string, body?: unknown}} [options] */
  const call = async (method, pathAndQuery, { token, body } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${pathAndQuery}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { stderr('Could not reach Frontline. Check FRONTLINE_API_URL and your connection.'); return { networkError: true }; }
    let json = null;
    try { json = await response.json(); } catch { /* non-JSON error page */ }
    return { status: response.status, json };
  };
  const savedToken = async () => {
    if (env.FRONTLINE_BUILDER_TOKEN) return TOKEN.test(env.FRONTLINE_BUILDER_TOKEN) ? env.FRONTLINE_BUILDER_TOKEN : null;
    const saved = await store.read(apiUrl);
    return saved && TOKEN.test(saved.token) && Date.parse(saved.expiresAt) > Date.now() ? saved.token : null;
  };
  const authFailure = () => { stderr('Not signed in, or the credential expired. Run: frontline auth login'); return EXIT.auth; };

  if (group === 'auth' && action === 'login') {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    let listener;
    try { listener = await listen({ expectedState: state }); }
    catch { stderr('Could not start the local login listener on 127.0.0.1.'); return EXIT.auth; }
    const loginUrl = `${apiUrl}/builder/cli?${new URLSearchParams({ port: String(listener.port), state, challenge })}`;
    if (!(await openBrowser(loginUrl))) stderr(`Open this address in your browser:\n${loginUrl}`);
    let code;
    try { code = await listener.wait(); } catch { stderr('Login was not completed.'); return EXIT.auth; }
    const exchanged = await call('POST', '/v1/builder/credentials/exchange', { body: { code, verifier } });
    if (exchanged.networkError) return EXIT.network;
    if (exchanged.status !== 201) return authFailure();
    await store.write(apiUrl, { token: exchanged.json.token, expiresAt: exchanged.json.expiresAt });
    stdout(JSON.stringify({ loggedIn: true, expiresAt: exchanged.json.expiresAt, scope: exchanged.json.scope }));
    return EXIT.ok;
  }
  if (group === 'auth' && action === 'logout') {
    const token = await savedToken();
    if (token) { const result = await call('DELETE', '/v1/builder/credentials/current', { token }); if (result.networkError) return EXIT.network; }
    await store.remove(apiUrl);
    stdout(JSON.stringify({ loggedOut: true }));
    return EXIT.ok;
  }
  if (group === 'feedback' && action === 'search') {
    const token = await savedToken();
    if (!token) return authFailure();
    const query = new URLSearchParams();
    for (const [flag, name] of [['query', 'q'], ['category', 'category'], ['agent-id', 'agentId'], ['agent-version-id', 'agentVersionId'], ['conversation-id', 'conversationId'], ['source', 'source'], ['status', 'status'], ['since', 'since'], ['limit', 'limit'], ['cursor', 'cursor']]) {
      if (values[flag] != null) query.set(name, values[flag]);
    }
    const result = await call('GET', `/v1/builder/feedback${query.size ? `?${query}` : ''}`, { token });
    if (result.networkError) return EXIT.network;
    if (result.status === 401 || result.status === 403) return authFailure();
    if (result.status !== 200) { stderr(result.json?.detail ?? `Request failed (${result.status}).`); return result.status === 400 ? EXIT.usage : EXIT.network; }
    const { records, nextCursor } = result.json;
    if (values.jsonl) { for (const record of records) stdout(JSON.stringify(record)); stdout(JSON.stringify({ nextCursor })); }
    else if (values.json) stdout(JSON.stringify(result.json));
    else { for (const record of records) stdout(humanLine(record)); if (nextCursor) stdout(`More: --cursor ${nextCursor}`); }
    return records.length === 0 && values['fail-empty'] ? EXIT.notFound : EXIT.ok;
  }
  if (group === 'feedback' && action === 'get' && target) {
    const token = await savedToken();
    if (!token) return authFailure();
    const result = await call('GET', `/v1/builder/feedback/${encodeURIComponent(target)}`, { token });
    if (result.networkError) return EXIT.network;
    if (result.status === 404) { stderr('No feedback with that id.'); return EXIT.notFound; }
    if (result.status === 401 || result.status === 403) return authFailure();
    if (result.status !== 200) { stderr(result.json?.detail ?? `Request failed (${result.status}).`); return EXIT.network; }
    stdout(values.json || values.jsonl ? JSON.stringify(result.json.record) : `${humanLine(result.json.record)}\n${result.json.record.submittedText}`);
    return EXIT.ok;
  }
  stderr(USAGE);
  return EXIT.usage;
}
