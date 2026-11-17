import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// PO-C16: the Google flow can ask the callback to send the browser back to /builder.
// The provider is faked (no call to Google); the adapter and the claims boundary are the real code.
const CLIENT_ID = 'frontline-test-client';
const CALLBACK_URL = 'https://frontline.test/v1/auth/google/callback';
const KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

function idToken(nonce) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const body = encode({ iss: 'https://accounts.google.com', aud: CLIENT_ID, nonce, email_verified: true, sub: 'builder-subject', iat: now - 10, exp: now + 3600 });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

/** The provider: Google's signing keys, and a token endpoint that answers with an ID token for this flow's nonce. */
const provider = (nonce) => vi.stubGlobal('fetch', vi.fn(async (url) => (String(url) === KEYS_URL ? json({ keys: [publicJwk] }) : json({ id_token: idToken(nonce) }))));

async function adapter() {
  const { createGoogleIdentityAdapter } = await import('../../server/api/google-identity.js');
  return createGoogleIdentityAdapter({ clientId: CLIENT_ID, clientSecret: 'test-secret', callbackUrl: CALLBACK_URL });
}

/** Runs one whole flow: start, then complete with the cookies start asked the browser to keep. */
async function flow(identity, startOptions, extraCookies = /** @type {Record<string, string>} */ ({})) {
  const started = identity.start(startOptions);
  const cookies = /** @type {Record<string, string>} */ (Object.fromEntries(started.setCookies.map((line) => line.split(';')[0].split('='))));
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  provider(cookies.fl_google_nonce);
  return { started, cookies: { ...cookies, ...extraCookies }, complete: () => identity.complete({ code: 'code', state, cookies: { ...cookies, ...extraCookies } }) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('Google flow returnTo', () => {
  it('sets the same three flow cookies as before when no returnTo is asked for', async () => {
    const identity = await adapter();
    const { started, complete } = await flow(identity);
    expect(started.setCookies.map((line) => line.split('=')[0])).toEqual(['fl_google_state', 'fl_google_verifier', 'fl_google_nonce']);
    expect(await complete()).toEqual({ subject: 'google:builder-subject', expiresAt: expect.any(String) });
    expect(identity.clearFlowCookies().map((line) => line.split('=')[0])).toEqual(['fl_google_state', 'fl_google_verifier', 'fl_google_nonce']);
  });

  it('carries /builder from start to the completed identity and clears its own cookie', async () => {
    const identity = await adapter();
    const { started, cookies, complete } = await flow(identity, { returnTo: '/builder' });
    expect(started.setCookies.map((line) => line.split('=')[0])).toContain('fl_google_return');
    expect(started.setCookies.find((line) => line.startsWith('fl_google_return='))).toMatch(/HttpOnly.*SameSite=Lax.*Secure/);
    expect(await complete()).toMatchObject({ subject: 'google:builder-subject', returnTo: '/builder' });
    expect(identity.clearFlowCookies(cookies).map((line) => line.split('=')[0])).toContain('fl_google_return');
  });

  it('refuses any other target, including absolute and protocol-relative addresses', async () => {
    const identity = await adapter();
    for (const returnTo of ['/app', '//evil.test', 'https://evil.test/builder', '/builder/../x', '', null, '__proto__']) {
      expect(() => identity.start({ returnTo: /** @type {any} */ (returnTo) })).toThrow('invalid_return_to');
    }
  });

  it('ignores a return marker left over from an earlier flow', async () => {
    const identity = await adapter();
    const earlier = await flow(identity, { returnTo: '/builder' });
    const stale = earlier.cookies.fl_google_return;
    const later = await flow(identity, undefined, { fl_google_return: stale });
    expect((await later.complete()).returnTo).toBeUndefined();
  });

  it('is passed through the claims boundary and clears the marker in the same response', async () => {
    const identity = await adapter();
    const { createAuthClaims } = await import('../../server/api/auth-claims.js');
    const queries = [];
    const claims = createAuthClaims({ pool: { query: async (sql) => { queries.push(sql); return { rows: [] }; } }, googleIdentity: identity });
    const started = claims.startGoogle({ returnTo: '/builder' });
    expect(started.setCookies.some((line) => line.startsWith('fl_google_return='))).toBe(true);
    const cookies = /** @type {Record<string, string>} */ (Object.fromEntries(started.setCookies.map((line) => line.split(';')[0].split('='))));
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    provider(cookies.fl_google_nonce);
    const done = await claims.completeGoogle({ code: 'code', state, browserCookies: cookies, previousAuthCookie: undefined });
    expect(done.returnTo).toBe('/builder');
    expect(done.setCookies.some((line) => line.startsWith('fl_google_return=;'))).toBe(true);
    expect(queries[0]).toContain('create_frontline_auth_session');
  });
});
