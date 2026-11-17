import { createHash, randomBytes } from 'node:crypto';
import { mapDatabaseError, problem } from './errors.js';
import { sha256 } from './http.js';

export const CREDENTIAL_PREFIX = 'flb_';
export const CREDENTIAL_TTL_SECONDS = 7 * 86_400;
export const CLI_CODE_TTL_SECONDS = 120;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN = /^flb_[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;

export const isCredentialToken = (value) => typeof value === 'string' && TOKEN.test(value);
export const newCredentialToken = () => `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
export const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

/** Signed-in builder approves the CLI login. Returns the one-time code for the loopback redirect. */
export async function createCliCode({ db, sessionToken, challenge, label = null }) {
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) throw problem(400, 'invalid_field', 'challenge: send a base64url SHA-256 challenge.');
  if (label != null && (typeof label !== 'string' || label.length > 80)) throw problem(400, 'invalid_field', 'label: use up to 80 characters.');
  const code = randomBytes(32).toString('base64url');
  try {
    const { rows } = await db.query('SELECT builder_cli_code_create($1,$2,$3,$4,$5) AS expires_at',
      [sha256(sessionToken), sha256(code), challenge, label, CLI_CODE_TTL_SECONDS]);
    return { code, expiresAt: new Date(rows[0].expires_at).toISOString() };
  } catch (error) { throw mapDatabaseError(error); }
}

/** The CLI proves it started the login by presenting the PKCE verifier. No session needed. */
export async function exchangeCliCode({ db, code, verifier, ttlSeconds = CREDENTIAL_TTL_SECONDS }) {
  if (typeof code !== 'string' || !CODE.test(code) || typeof verifier !== 'string' || !VERIFIER.test(verifier)) throw problem(401, 'credential_invalid', 'The login code is invalid or expired.');
  const token = newCredentialToken();
  try {
    const { rows } = await db.query('SELECT * FROM builder_cli_code_exchange($1,$2,$3,$4)', [sha256(code), pkceChallenge(verifier), sha256(token), ttlSeconds]);
    if (!rows[0]) throw problem(401, 'credential_invalid', 'The login code is invalid or expired.');
    return { token, credentialId: rows[0].id, expiresAt: new Date(rows[0].expires_at).toISOString(), scope: 'feedback:read' };
  } catch (error) { throw mapDatabaseError(error); }
}

export async function revokeCredential({ db, sessionToken, id }) {
  try {
    const { rows } = await db.query('SELECT revoke_builder_credential($1,$2::uuid) AS revoked', [sha256(sessionToken), id]);
    if (!rows[0].revoked) throw problem(404, 'not_found', 'Credential not found.');
  } catch (error) { throw mapDatabaseError(error); }
}

export async function revokeCurrentCredential({ db, token }) {
  if (!isCredentialToken(token)) throw problem(401, 'credential_invalid', 'The credential is missing, expired or revoked.');
  const { rows } = await db.query('SELECT revoke_builder_credential_by_token($1) AS revoked', [sha256(token)]);
  if (!rows[0].revoked) throw problem(401, 'credential_invalid', 'The credential is missing, expired or revoked.');
}

export async function isBuilderSession({ db, sessionToken }) {
  const { rows } = await db.query('SELECT builder_session_status($1) AS builder', [sha256(sessionToken)]);
  return rows[0].builder === true;
}
