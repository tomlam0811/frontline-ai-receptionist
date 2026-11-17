import { createHash, randomBytes } from 'node:crypto';
import { createGoogleIdentityAdapter } from './google-identity.js';

const FIRST_NAME_COOKIE = 'fl_first_name';
// Readable profile cookies for the greeting and the Account page, with the verified claim each one comes from.
// They end with the session and are cleared with it, so nothing about the person is stored on the server.
const PROFILE_COOKIES = [['fl_first_name', 'firstName'], ['fl_last_name', 'lastName'], ['fl_email', 'email']];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

function fail(code) {
  return Object.assign(new Error(code), { code });
}

/** @param {{maxAge?: number, clear?: boolean, secure?: boolean, httpOnly?: boolean}} [options] */
function cookie(name, value, options = {}) {
  let localHttp = false;
  try {
    const app = new URL(process.env.APP_BASE_URL);
    localHttp = app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname);
  } catch { /* Production remains secure when the app origin is unset. */ }
  const { maxAge, clear = false, secure = process.env.NODE_ENV === 'production' && !localHttp, httpOnly = true } = options;
  return `${name}=${clear ? '' : value}${httpOnly ? '; HttpOnly' : ''}; Path=/; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${clear ? 0 : maxAge}`;
}

/** Set-Cookie lines that clear the readable profile cookies (first name, last name, email). */
export const clearProfileCookies = () => PROFILE_COOKIES.map(([name]) => cookie(name, '', { clear: true, httpOnly: false }));

/**
 * Set-Cookie lines that end a signed-in browser: the session, the profile cookies and the owner target hint.
 * Account deletion answers with these (server/api/post-onboarding/routes.js).
 */
export const signedOutCookies = () => [cookie('fl_auth', '', { clear: true }), ...clearProfileCookies(), cookie('fl_owner_target', '', { clear: true })];

/**
 * Service boundary for POST /v1/claims/grants, POST /v1/identity/sessions,
 * POST /v1/claims, and POST /v1/identity/logout. Caller must enforce the
 * existing CSRF/origin policy and derive cookie values from the HTTP request.
 * Do not put capability, grant, or auth tokens in JSON, URLs, or logs.
 */
/** @param {{pool?: import('pg').Pool, googleIdentity?: ReturnType<typeof createGoogleIdentityAdapter>}} [options] */
export function createAuthClaims({ pool, googleIdentity = createGoogleIdentityAdapter() } = {}) {
  if (!pool?.query) throw new TypeError('A Postgres pool is required for claims.');
  return {
    isConfigured: () => googleIdentity.isConfigured?.() === true,
    googleConfigured: () => googleIdentity.isConfigured?.() === true,
    startGoogle: (options) => googleIdentity.start(options),
    clearGoogleFlow: () => googleIdentity.clearFlowCookies(),
    async completeGoogle({ code, state, browserCookies, previousAuthCookie }) {
      const verified = await googleIdentity.complete({ code, state, cookies: browserCookies });
      const authToken = token();
      const expiresAt = new Date(Math.min(Date.parse(verified.expiresAt), Date.now() + 30 * 60 * 1000)).toISOString();
      await pool.query('SELECT create_frontline_auth_session($1,$2,$3,$4::timestamptz)',
        [hash(authToken), verified.subject, 'google-oidc', expiresAt]);
      if (validToken(previousAuthCookie)) await pool.query('SELECT revoke_frontline_auth_session($1)', [hash(previousAuthCookie)]);
      const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
      const secure = googleIdentity.cookieSecure();
      // First name, last name and email are for display only (greeting, Account page). Each lives in a readable cookie
      // that ends with the session, so nothing new is stored on the server. A claim Google did not send clears its cookie.
      const profileCookies = PROFILE_COOKIES.map(([name, field]) => (verified[field]
        ? cookie(name, encodeURIComponent(verified[field]), { maxAge, secure, httpOnly: false })
        : cookie(name, '', { clear: true, httpOnly: false })));
      return { expiresAt, ...('returnTo' in verified && verified.returnTo ? { returnTo: verified.returnTo } : {}), setCookies: [cookie('fl_auth', authToken, { maxAge, secure }), ...profileCookies, ...googleIdentity.clearFlowCookies(browserCookies)] };
    },
    async issueGrant({ workspaceCookie, demoId, targetKind, targetId }) {
      if (!googleIdentity.isConfigured?.()) throw fail('identity_provider_unavailable');
      if (!validToken(workspaceCookie) || !uuid(demoId) || !['agent', 'workspace'].includes(targetKind) || !uuid(targetId)) throw fail('claim_unavailable');
      const grant = token();
      const { rows } = await pool.query('SELECT issue_frontline_claim_grant($1,$2::uuid,$3,$4::uuid,$5) AS expires_at',
        [hash(workspaceCookie), demoId, targetKind, targetId, hash(grant)]);
      const expiresAt = rows[0]?.expires_at;
      if (!expiresAt) throw fail('claim_unavailable');
      return { expiresAt, setCookie: cookie('fl_claim', grant, { maxAge: Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)) }) };
    },
    async claim({ workspaceCookie, grantCookie, authCookie, demoId }) {
      if (!googleIdentity.isConfigured?.()) throw fail('identity_provider_unavailable');
      if (![grantCookie, authCookie].every(validToken) || !uuid(demoId) || (workspaceCookie && !validToken(workspaceCookie))) throw fail('claim_unavailable');
      const { rows } = await pool.query('SELECT * FROM claim_frontline_scope($1,$2,$3,$4::uuid)',
        [workspaceCookie ? hash(workspaceCookie) : '', hash(grantCookie), hash(authCookie), demoId]);
      const row = rows[0];
      if (!row || row.demo_id !== demoId) throw fail('claim_unavailable');
      return {
        ownership: { kind: row.target_kind, id: row.target_id },
        workspaceId: row.owner_scope_id,
        tenantId: row.tenant_id,
        // Keep the grant only long enough to retry a lost 201 response. The
        // database binds it to this demo and verified subject; the anonymous
        // workspace capability is revoked immediately by the claim transaction.
        clearCookies: [cookie('fl_workspace', '', { clear: true }), cookie('fl_claim', grantCookie, { maxAge: 120 })],
      };
    },
    async resolveMemberScope({ authCookie, workspaceId }) {
      if (!googleIdentity.isConfigured?.()) return null;
      if (!validToken(authCookie) || !uuid(workspaceId)) return null;
      const { rows } = await pool.query('SELECT resolve_frontline_member_scope($1,$2::uuid) AS id', [hash(authCookie), workspaceId]);
      return rows[0]?.id ?? null;
    },
    async logout({ authCookie }) {
      if (validToken(authCookie)) await pool.query('SELECT revoke_frontline_auth_session($1)', [hash(authCookie)]);
      // clearNameCookie stays for the existing caller; clearProfileCookies clears the first name, last name and email together.
      return { clearCookie: cookie('fl_auth', '', { clear: true }), clearNameCookie: cookie(FIRST_NAME_COOKIE, '', { clear: true, httpOnly: false }), clearProfileCookies: clearProfileCookies() };
    },
  };
}
