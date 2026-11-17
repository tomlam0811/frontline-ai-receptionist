import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = 'frontline-test-client';
const CALLBACK_URL = 'https://frontline.test/v1/auth/google/callback';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const cookies = {
  fl_google_state: 's'.repeat(43),
  fl_google_verifier: 'v'.repeat(43),
  fl_google_nonce: 'n'.repeat(43),
};

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
  };
}

function idToken({ kid, privateKey, claims = {} }) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    nonce: cookies.fl_google_nonce,
    email_verified: true,
    sub: 'google-subject',
    iat: now - 10,
    exp: now + 3600,
    ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * @param {{tokens: Record<string, string>, keySets: Array<Array<JsonWebKey>>}} input
 */
function provider(input) {
  let keyRequest = 0;
  const fetcher = vi.fn(/** @param {string | URL | Request} url @param {RequestInit} [options] */ async (url, options = {}) => {
    const href = String(url);
    if (href === TOKEN_URL) {
      const body = options.body instanceof URLSearchParams ? options.body : new URLSearchParams(String(options.body ?? ''));
      return json({ id_token: input.tokens[body.get('code') ?? ''] });
    }
    if (href === KEYS_URL) {
      const keys = input.keySets[Math.min(keyRequest, input.keySets.length - 1)];
      keyRequest += 1;
      return json({ keys });
    }
    throw new Error(`Unexpected provider request: ${href}`);
  });
  return { fetcher, keyRequests: () => keyRequest };
}

async function adapter(fetcher) {
  vi.stubGlobal('fetch', fetcher);
  const { createGoogleIdentityAdapter } = await import('../server/api/google-identity.js');
  return createGoogleIdentityAdapter({ clientId: CLIENT_ID, clientSecret: 'test-secret', callbackUrl: CALLBACK_URL });
}

async function complete(identity, code) {
  return identity.complete({ code, state: cookies.fl_google_state, cookies });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Google identity JWKS rotation', () => {
  it('refreshes a fresh cache once when Google presents a new signing key', async () => {
    const oldKey = keyPair('old-key');
    const newKey = keyPair('new-key');
    const network = provider({
      tokens: {
        old: idToken({ kid: 'old-key', privateKey: oldKey.privateKey }),
        rotated: idToken({ kid: 'new-key', privateKey: newKey.privateKey, claims: { sub: 'rotated-subject' } }),
      },
      keySets: [[oldKey.publicJwk], [oldKey.publicJwk, newKey.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    await expect(complete(identity, 'old')).resolves.toMatchObject({ subject: 'google:google-subject' });
    await expect(complete(identity, 'rotated')).resolves.toMatchObject({ subject: 'google:rotated-subject' });
    expect(network.keyRequests()).toBe(2);
  });

  it('shares one bounded refresh across concurrent unknown-key verifications', async () => {
    const oldKey = keyPair('old-concurrent');
    const newKey = keyPair('new-concurrent');
    const network = provider({
      tokens: {
        old: idToken({ kid: 'old-concurrent', privateKey: oldKey.privateKey }),
        rotated: idToken({ kid: 'new-concurrent', privateKey: newKey.privateKey }),
      },
      keySets: [[oldKey.publicJwk], [oldKey.publicJwk, newKey.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    await complete(identity, 'old');
    const results = await Promise.all(Array.from({ length: 12 }, () => complete(identity, 'rotated')));

    expect(results.every((result) => result.subject === 'google:google-subject')).toBe(true);
    expect(network.keyRequests()).toBe(2);
  });

  it('rate limits sequential unknown keys after a forced refresh', async () => {
    const trusted = keyPair('trusted');
    const missingOne = keyPair('missing-one');
    const missingTwo = keyPair('missing-two');
    const network = provider({
      tokens: {
        trusted: idToken({ kid: 'trusted', privateKey: trusted.privateKey }),
        first: idToken({ kid: 'missing-one', privateKey: missingOne.privateKey }),
        second: idToken({ kid: 'missing-two', privateKey: missingTwo.privateKey }),
      },
      keySets: [[trusted.publicJwk], [trusted.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    await complete(identity, 'trusted');
    await expect(complete(identity, 'first')).rejects.toMatchObject({ code: 'identity_unverified' });
    await expect(complete(identity, 'second')).rejects.toMatchObject({ code: 'identity_unverified' });
    expect(network.keyRequests()).toBe(2);
  });
});

describe('Google identity token validation', () => {
  it.each([
    ['issuer', { iss: 'https://attacker.example' }],
    ['audience', { aud: 'another-client' }],
    ['nonce', { nonce: 'x'.repeat(43) }],
    ['verified email', { email_verified: false }],
    ['expiry', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['issued-at time', { iat: Math.floor(Date.now() / 1000) + 120 }],
  ])('preserves the %s check', async (_name, changedClaims) => {
    const trusted = keyPair('claims-key');
    const network = provider({
      tokens: { invalid: idToken({ kid: 'claims-key', privateKey: trusted.privateKey, claims: changedClaims }) },
      keySets: [[trusted.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    await expect(complete(identity, 'invalid')).rejects.toMatchObject({ code: 'identity_unverified' });
  });

  it('preserves signature verification for a known key id', async () => {
    const trusted = keyPair('signature-key');
    const attacker = keyPair('signature-key');
    const network = provider({
      tokens: { invalid: idToken({ kid: 'signature-key', privateKey: attacker.privateKey }) },
      keySets: [[trusted.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    await expect(complete(identity, 'invalid')).rejects.toMatchObject({ code: 'identity_unverified' });
  });
});

describe('Owner first name for the greeting', () => {
  it('reads a clean given_name from the verified token and drops anything else', async () => {
    const key = keyPair('name-key');
    const network = provider({
      tokens: {
        clean: idToken({ kid: 'name-key', privateKey: key.privateKey, claims: { given_name: '  Mary   Ann ' } }),
        accented: idToken({ kid: 'name-key', privateKey: key.privateKey, claims: { given_name: 'Zoë' } }),
        markup: idToken({ kid: 'name-key', privateKey: key.privateKey, claims: { given_name: '<b>Tom</b>' } }),
        long: idToken({ kid: 'name-key', privateKey: key.privateKey, claims: { given_name: 'A'.repeat(41) } }),
        absent: idToken({ kid: 'name-key', privateKey: key.privateKey }),
      },
      keySets: [[key.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    expect((await complete(identity, 'clean')).firstName).toBe('Mary Ann');
    expect((await complete(identity, 'accented')).firstName).toBe('Zoë');
    expect(await complete(identity, 'markup')).not.toHaveProperty('firstName');
    expect(await complete(identity, 'long')).not.toHaveProperty('firstName');
    expect(await complete(identity, 'absent')).not.toHaveProperty('firstName');
  });

  it('is set as a readable cookie that lasts as long as the session, and cleared at sign-out', async () => {
    const key = keyPair('cookie-key');
    const network = provider({
      tokens: {
        named: idToken({ kid: 'cookie-key', privateKey: key.privateKey, claims: { given_name: 'Tom' } }),
        unnamed: idToken({ kid: 'cookie-key', privateKey: key.privateKey }),
      },
      keySets: [[key.publicJwk]],
    });
    const identity = await adapter(network.fetcher);
    const { createAuthClaims } = await import('../server/api/auth-claims.js');
    const claims = createAuthClaims({ pool: { query: async () => ({ rows: [] }) }, googleIdentity: identity });
    const named = await claims.completeGoogle({ code: 'named', state: cookies.fl_google_state, browserCookies: cookies, previousAuthCookie: undefined });
    const nameCookie = named.setCookies.find((line) => line.startsWith('fl_first_name='));
    expect(nameCookie).toMatch(/^fl_first_name=Tom; Path=\/; SameSite=Strict/);
    expect(nameCookie).not.toContain('HttpOnly');
    expect(named.setCookies.find((line) => line.startsWith('fl_auth='))).toContain('HttpOnly');
    const unnamed = await claims.completeGoogle({ code: 'unnamed', state: cookies.fl_google_state, browserCookies: cookies, previousAuthCookie: undefined });
    expect(unnamed.setCookies.find((line) => line.startsWith('fl_first_name='))).toContain('Max-Age=0');
    const out = await claims.logout({ authCookie: undefined });
    expect(out.clearNameCookie).toMatch(/^fl_first_name=; Path=\/.*Max-Age=0/);
  });
});

describe('Owner account details (PO-S18)', () => {
  it('reads a clean family_name and email from the verified token and drops anything else', async () => {
    const key = keyPair('profile-key');
    const token = (claims) => idToken({ kid: 'profile-key', privateKey: key.privateKey, claims });
    const network = provider({
      tokens: {
        full: token({ given_name: 'Mary', family_name: '  O’Brien   Lee ', email: '  Mary.OBrien@Example.com ' }),
        apostrophe: token({ email: "o'brien+front@example.co.uk" }),
        markup: token({ family_name: '<i>Lee</i>', email: '<mary@example.com>' }),
        long: token({ family_name: 'B'.repeat(41), email: `${'a'.repeat(250)}@x.co` }),
        malformed: token({ email: 'not an email' }),
        absent: token({}),
      },
      keySets: [[key.publicJwk]],
    });
    const identity = await adapter(network.fetcher);

    expect(await complete(identity, 'full')).toMatchObject({ firstName: 'Mary', lastName: 'O’Brien Lee', email: 'Mary.OBrien@Example.com' });
    expect((await complete(identity, 'apostrophe')).email).toBe("o'brien+front@example.co.uk");
    for (const code of ['markup', 'long', 'absent']) {
      const result = await complete(identity, code);
      expect(result, code).not.toHaveProperty('lastName');
      expect(result, code).not.toHaveProperty('email');
    }
    expect(await complete(identity, 'malformed')).not.toHaveProperty('email');
  });

  it('sets readable cookies for the session lifetime, clears a missing one, and clears all of them at sign-out', async () => {
    const key = keyPair('profile-cookie-key');
    const network = provider({
      tokens: {
        full: idToken({ kid: 'profile-cookie-key', privateKey: key.privateKey, claims: { given_name: 'Tom', family_name: 'Lam', email: 'tom@example.com' } }),
        firstOnly: idToken({ kid: 'profile-cookie-key', privateKey: key.privateKey, claims: { given_name: 'Tom' } }),
      },
      keySets: [[key.publicJwk]],
    });
    const identity = await adapter(network.fetcher);
    const { createAuthClaims, signedOutCookies } = await import('../server/api/auth-claims.js');
    const claims = createAuthClaims({ pool: { query: async () => ({ rows: [] }) }, googleIdentity: identity });
    const cookieOf = (result, name) => result.setCookies.find((line) => line.startsWith(`${name}=`));
    const full = await claims.completeGoogle({ code: 'full', state: cookies.fl_google_state, browserCookies: cookies, previousAuthCookie: undefined });
    const authAge = cookieOf(full, 'fl_auth').match(/Max-Age=(\d+)/)?.[1];
    expect(cookieOf(full, 'fl_last_name')).toMatch(/^fl_last_name=Lam; Path=\/; SameSite=Strict/);
    expect(cookieOf(full, 'fl_email')).toMatch(/^fl_email=tom%40example\.com; Path=\/; SameSite=Strict/);
    for (const name of ['fl_first_name', 'fl_last_name', 'fl_email']) {
      expect(cookieOf(full, name)).not.toContain('HttpOnly');
      expect(cookieOf(full, name)).toContain(`Max-Age=${authAge}`);
    }
    // A later sign-in without a claim clears the value an earlier one left.
    const firstOnly = await claims.completeGoogle({ code: 'firstOnly', state: cookies.fl_google_state, browserCookies: cookies, previousAuthCookie: undefined });
    expect(cookieOf(firstOnly, 'fl_first_name')).toMatch(/^fl_first_name=Tom;/);
    expect(cookieOf(firstOnly, 'fl_last_name')).toContain('Max-Age=0');
    expect(cookieOf(firstOnly, 'fl_email')).toContain('Max-Age=0');
    const out = await claims.logout({ authCookie: undefined });
    expect(out.clearProfileCookies.map((line) => line.split('=')[0])).toEqual(['fl_first_name', 'fl_last_name', 'fl_email']);
    for (const line of out.clearProfileCookies) expect(line).toMatch(/=; Path=\/.*Max-Age=0/);
    // Account deletion signs the browser out of everything at once.
    expect(signedOutCookies().map((line) => line.split('=')[0])).toEqual(expect.arrayContaining(['fl_auth', 'fl_first_name', 'fl_last_name', 'fl_email', 'fl_owner_target']));
  });
});
