import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const KEY_CACHE_MS = 10 * 60 * 1000;
const FORCED_KEY_REFRESH_COOLDOWN_MS = 60 * 1000;
const oauthToken = () => randomBytes(32).toString('base64url');
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const fail = (code) => Object.assign(new Error(code), { code });
// Where a flow may send the browser after sign-in. Anything else is refused, so the option cannot become an open redirect.
const RETURN_TARGETS = { '/builder': 'builder' };
const RETURN_COOKIE = 'fl_google_return';
const returnMarker = (target, state) => `${target}.${createHash('sha256').update(state).digest('hex').slice(0, 32)}`;
let cachedKeys = { until: 0, values: [], forcedAt: 0 };
let keyRequest = null;

function flowCookie(name, value, clear = false, secureCookie = true) {
  const secure = secureCookie ? '; Secure' : '';
  return `${name}=${clear ? '' : value}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${clear ? 0 : 600}`;
}

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw fail('identity_unverified');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

async function getKeys(force = false) {
  const now = Date.now();
  if (!force && cachedKeys.until > now) return cachedKeys.values;
  // Concurrent cache misses share one provider request. An unknown key can
  // force one early refresh for rotation, then the cooldown prevents arbitrary
  // token headers from turning every verification into a Google request.
  if (keyRequest) return keyRequest;
  if (force && cachedKeys.forcedAt > now - FORCED_KEY_REFRESH_COOLDOWN_MS) return cachedKeys.values;
  if (force) cachedKeys.forcedAt = now;
  keyRequest = (async () => {
    const response = await fetch(KEYS, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw fail('identity_provider_unavailable');
    const body = await response.json();
    if (!Array.isArray(body?.keys)) throw fail('identity_provider_unavailable');
    cachedKeys = { until: Date.now() + KEY_CACHE_MS, values: body.keys, forcedAt: cachedKeys.forcedAt };
    return cachedKeys.values;
  })();
  try { return await keyRequest; }
  finally { keyRequest = null; }
}

function signingKey(keys, kid) {
  return keys.find((item) => item.kid === kid && item.kty === 'RSA'
    && (item.use == null || item.use === 'sig') && (item.alg == null || item.alg === 'RS256'));
}

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '\u2019.-]*$/u;
const NAME_MAX = 40;
const EMAIL_MAX = 254;

/** A display name from one verified claim: NFC, inner whitespace collapsed, trimmed, letters first, at most 40 characters. */
function nameFromClaim(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= NAME_MAX && NAME_PATTERN.test(name) ? name : null;
}

/**
 * The signed-in person's first name for a greeting, from Google's verified `given_name` claim. Display text only:
 * it is trimmed, limited to letters, marks, spaces, apostrophes, periods and hyphens, and capped at 40 characters.
 * Anything else yields null and the greeting has no name.
 */
export function firstNameFromClaims(claims) {
  return nameFromClaim(claims?.given_name);
}

/** The last name for the Account page, from the verified `family_name` claim, under the same rules as the first name. */
export function lastNameFromClaims(claims) {
  return nameFromClaim(claims?.family_name);
}

/**
 * The email address for the Account page, from the verified `email` claim. Google has confirmed it (`email_verified`
 * is required before this runs). Display text only: NFC, trimmed, one @ with text on both sides, no spaces, angle
 * brackets, double quotes or control characters, at most 254 characters. Anything else yields null and the page has no email row.
 */
export function emailFromClaims(claims) {
  if (typeof claims?.email !== 'string') return null;
  const email = claims.email.normalize('NFC').trim();
  return email.length <= EMAIL_MAX && /^[^\s@<>"\p{Cc}]+@[^\s@<>"\p{Cc}]+$/u.test(email) ? email : null;
}

async function verifyIdToken(idToken, audience, nonce) {
  if (typeof idToken !== 'string' || idToken.length > 16_384) throw fail('identity_unverified');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw fail('identity_unverified');
  let header, claims;
  try { header = decodePart(parts[0]); claims = decodePart(parts[1]); }
  catch { throw fail('identity_unverified'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256) throw fail('identity_unverified');
  let key = signingKey(await getKeys(), header.kid);
  if (!key) key = signingKey(await getKeys(true), header.kid);
  if (!key) throw fail('identity_unverified');
  let valid = false;
  try { valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')); }
  catch { throw fail('identity_unverified'); }
  const now = Math.floor(Date.now() / 1000);
  if (!valid || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)
    || claims.aud !== audience || claims.nonce !== nonce || claims.email_verified !== true
    || typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255
    || !Number.isSafeInteger(claims.exp) || claims.exp <= now
    || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60) throw fail('identity_unverified');
  const firstName = firstNameFromClaims(claims);
  const lastName = lastNameFromClaims(claims);
  const email = emailFromClaims(claims);
  return { subject: `google:${claims.sub}`, expiresAt: new Date(claims.exp * 1000).toISOString(), ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}), ...(email ? { email } : {}) };
}

export function createGoogleIdentityAdapter(config = {}) {
  const clientId = config.clientId ?? process.env.AUTH_CLIENT_ID;
  const clientSecret = config.clientSecret ?? process.env.AUTH_CLIENT_SECRET;
  const callbackUrl = config.callbackUrl ?? process.env.AUTH_CALLBACK_URL;
  let callback;
  try {
    callback = new URL(callbackUrl);
    if (callback.pathname !== '/v1/auth/google/callback' || callback.search || callback.hash
      || (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname)))) callback = null;
  } catch { callback = null; }
  const configured = Boolean(clientId && clientSecret && callback);
  const secureCookie = callback?.protocol === 'https:';
  return {
    isConfigured: () => configured,
    cookieSecure: () => secureCookie,
    /** @param {{returnTo?: '/builder'}} [options] returnTo asks the callback to send the browser back to that page. */
    start({ returnTo } = {}) {
      if (!configured) throw fail('identity_provider_unavailable');
      if (returnTo !== undefined && !Object.hasOwn(RETURN_TARGETS, returnTo)) throw fail('invalid_return_to');
      const state = oauthToken();
      const verifier = oauthToken();
      const nonce = oauthToken();
      const authorize = new URL(AUTHORIZE);
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback.href,
        scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      const setCookies = [
        flowCookie('fl_google_state', state, false, secureCookie), flowCookie('fl_google_verifier', verifier, false, secureCookie), flowCookie('fl_google_nonce', nonce, false, secureCookie),
      ];
      // The marker is bound to this flow's state, so a leftover cookie from an earlier flow never redirects a later sign-in.
      if (returnTo !== undefined) setCookies.push(flowCookie(RETURN_COOKIE, returnMarker(RETURN_TARGETS[returnTo], state), false, secureCookie));
      return { authorizationUrl: authorize.href, setCookies };
    },
    async complete({ code, state, cookies }) {
      if (!configured) throw fail('identity_provider_unavailable');
      if (typeof code !== 'string' || !code || code.length > 4096 || !validToken(state)
        || state !== cookies.fl_google_state || !validToken(cookies.fl_google_verifier)
        || !validToken(cookies.fl_google_nonce)) throw fail('identity_unverified');
      const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: callback.href, grant_type: 'authorization_code', code_verifier: cookies.fl_google_verifier });
      const response = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw fail('identity_unverified');
      const tokens = await response.json();
      const identity = await verifyIdToken(tokens.id_token, clientId, cookies.fl_google_nonce);
      const returnTo = Object.keys(RETURN_TARGETS).find((path) => cookies[RETURN_COOKIE] === returnMarker(RETURN_TARGETS[path], state)) ?? null;
      return returnTo ? { ...identity, returnTo } : identity;
    },
    /** @param {Record<string, string>} [cookies] pass the request cookies to also clear the return marker when the flow set one. */
    clearFlowCookies: (cookies) => [...['fl_google_state', 'fl_google_verifier', 'fl_google_nonce'], ...(cookies?.[RETURN_COOKIE] ? [RETURN_COOKIE] : [])].map((name) => flowCookie(name, '', true, secureCookie)),
  };
}
