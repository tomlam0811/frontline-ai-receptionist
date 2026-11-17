import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { mapDatabaseError, problem } from './errors.js';
import { sha256 } from './http.js';
import { DEFAULT_RECEPTIONIST_NAME } from './receptionist-name.js';
import { assertHasKnowledge, assertNotDeleting, assertNotPaused, readLineage } from './lineage.js';

export const SHARE_LIFETIME_HOURS = 24;
export const SHARE_MAX_UNUSED = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Database messages that only the share functions raise.
const SHARE_ERRORS = {
  share_limit_reached: [409, 'share_limit_reached', 'You already have 5 unused links. Revoke one to create another.'],
  stale_share: [409, 'stale_share', 'This link changed. Refresh and try again.'],
};
function mapShareError(error) {
  const entry = SHARE_ERRORS[String(error?.message ?? '')];
  return entry ? problem(entry[0], entry[1], entry[2]) : mapDatabaseError(error);
}

export const newShareToken = () => randomBytes(32).toString('base64url');
export const isShareToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

/** The link the owner copies. The token is in the fragment so it never reaches a server log. */
export const shareUrl = (appBaseUrl, token) => `${appBaseUrl.replace(/\/$/, '')}/shared#t=${token}`;

/**
 * Creates one link for the current version. The raw token is returned once and only its hash
 * is stored. A replay of the same Idempotency-Key returns the stored link without a URL
 * because the secret cannot be recovered.
 */
export async function createShare({ db, actor, appBaseUrl, body, idempotencyKey, now = new Date() }) {
  if (body?.expectedAgentVersionId !== actor.currentAgentVersionId) throw problem(409, 'stale_agent_version', `${actor.receptionistName ?? DEFAULT_RECEPTIONIST_NAME} changed while this page was open. Reload to share the latest version.`);
  if (actor.currentVersionAvailable === false) throw problem(422, 'agent_not_ready', `${actor.receptionistName ?? DEFAULT_RECEPTIONIST_NAME} is not ready to share.`);
  const token = newShareToken();
  const key = idempotencyKey ?? `auto_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + SHARE_LIFETIME_HOURS * 3_600_000).toISOString();
  const digest = createHash('sha256').update(JSON.stringify([actor.stableAgentId, actor.currentAgentVersionId])).digest('hex');
  try {
    const row = await inOwnerScope(db, actor.scopeId, async (tx) => {
      // The share lock keeps a pause from committing between this check and the insert.
      const state = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR SHARE', [actor.scopeId])).rows[0]?.state;
      const lineage = state && readLineage(state, actor.stableAgentId);
      if (!lineage) throw problem(404, 'not_found', 'Not found.');
      assertNotDeleting(lineage);
      assertNotPaused(lineage);
      assertHasKnowledge(state, lineage);
      return (await tx.query(
        'SELECT * FROM share_create($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::timestamptz,$7,$8,$9)',
        [actor.scopeId, actor.stableAgentId, actor.currentAgentVersionId, sha256(token), actor.creatorRef, expiresAt, key, digest, SHARE_MAX_UNUSED])).rows[0];
    });
    return { share: { shareId: row.id, url: row.replayed ? null : shareUrl(appBaseUrl, token), status: row.status, expiresAt: new Date(row.expires_at).toISOString(), agentVersionId: row.agent_version_id }, replayed: row.replayed };
  } catch (error) { throw mapShareError(error); }
}

export async function listShares({ db, actor }) {
  try {
    const rows = await inOwnerScope(db, actor.scopeId, async (tx) => (await tx.query('SELECT * FROM share_list($1::uuid,$2::uuid)', [actor.scopeId, actor.stableAgentId])).rows);
    return {
      shares: rows.map((row) => ({
        shareId: row.id, status: row.status, agentVersionId: row.agent_version_id,
        versionLabel: actor.versionNumbers[row.agent_version_id] ? `Version ${actor.versionNumbers[row.agent_version_id]}` : null,
        isCurrentVersion: row.agent_version_id === actor.currentAgentVersionId,
        createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
        activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
        consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        version: row.version,
      })),
    };
  } catch (error) { throw mapShareError(error); }
}

/**
 * Revokes a link. If a conversation was live, `endLiveCall({scopeId, demoId, sessionId, reservationId, reason})`
 * ends it through the normal terminal path; the link is revoked either way.
 */
export async function revokeShare({ db, actor, shareId, expectedVersion, endLiveCall }) {
  if (!UUID.test(shareId)) throw problem(404, 'not_found', 'Not found.');
  if (!Number.isInteger(expectedVersion)) throw problem(400, 'invalid_field', 'expectedVersion: send the version you are looking at.');
  let row;
  try {
    row = await inOwnerScope(db, actor.scopeId, async (tx) => (await tx.query('SELECT * FROM share_revoke($1::uuid,$2::uuid,$3)', [actor.scopeId, shareId, expectedVersion])).rows[0]);
  } catch (error) { throw mapShareError(error); }
  if (row.was_live) await endLiveCall?.({ scopeId: actor.scopeId, demoId: row.demo_id, sessionId: row.session_id, reservationId: row.reservation_id, reason: 'share_revoked' });
  return { shareId: row.id, status: 'revoked' };
}

// Lifecycle hooks the existing demo paths call at connection (PO-C1). Both are fenced by the
// lease generation stored on the demo, so a late worker from an earlier attempt changes nothing.
export async function markShareActive({ db, demo }) {
  if (!demo?.shareGrantId) return false;
  return (await db.query('SELECT share_mark_active($1::uuid,$2) AS changed', [demo.shareGrantId, demo.leaseGeneration])).rows[0].changed;
}

export async function markShareConsumed({ db, demo, reason }) {
  if (!demo?.shareGrantId) return false;
  return (await db.query('SELECT share_mark_consumed($1::uuid,$2,$3) AS changed', [demo.shareGrantId, demo.leaseGeneration, reason ?? demo.terminalReason ?? 'ended'])).rows[0].changed;
}

/** Watchdog sweep: expires overdue links and hands back live conversations to end. */
export async function expireDueShares({ db, limit = 100, endLiveCall }) {
  const { rows } = await db.query('SELECT * FROM share_expire_due($1)', [limit]);
  for (const row of rows.filter((item) => item.was_live)) await endLiveCall?.({ scopeId: row.owner_scope_id, demoId: row.demo_id, sessionId: row.session_id, reservationId: row.reservation_id, reason: 'share_expired' });
  return { expired: rows.length };
}
