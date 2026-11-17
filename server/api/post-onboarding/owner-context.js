import { inOwnerScope } from './database.js';
import { businessNameFor, isDeleting, knownVersionIds, readLineage, versionNumbers } from './lineage.js';
import { parseCookies, sha256 } from './http.js';
import { receptionistNameOf } from './receptionist-name.js';
import { unavailableVersionIds } from './source-redaction.js';

const AUTH_COOKIE = /^[a-f0-9]{64}$/;

/**
 * Resolves the signed-in owner of /v1/agents/:stableAgentId/... from the fl_auth cookie.
 * It uses the same SQL function as the existing owner routes (resolve_frontline_claimed_target),
 * so a person who does not own the agent gets null, never a different scope.
 * Returns the `actor` shape that submitFeedback expects, or null. A receptionist that is being deleted is gone: null,
 * unless the caller passes `allowDeleting` (only the delete route does, so a repeated delete finds its job).
 */
export function createOwnerResolver({ db }) {
  return async function resolveOwner(request, stableAgentId, { allowDeleting = false } = {}) {
    const authCookie = parseCookies(request).fl_auth;
    if (!authCookie || !AUTH_COOKIE.test(authCookie)) return null;
    const sessionHash = sha256(authCookie);
    const { rows } = await db.query('SELECT resolve_frontline_claimed_target($1,$2,$3::uuid) AS id', [sessionHash, 'agent', stableAgentId]);
    const scopeId = rows[0]?.id;
    if (!scopeId) return null;
    const creator = await db.query('SELECT frontline_session_subject_ref($1) AS ref', [sessionHash]);
    const creatorRef = creator.rows[0]?.ref;
    if (!creatorRef) return null;
    const state = await inOwnerScope(db, scopeId, async (tx) => {
      const result = await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid', [scopeId]);
      return result.rows[0]?.state ?? null;
    });
    const lineage = state && readLineage(state, stableAgentId);
    if (!lineage || (isDeleting(lineage) && !allowDeleting)) return null;
    const unavailable = unavailableVersionIds(lineage);
    return {
      scopeId, stableAgentId, creatorKind: 'owner', creatorRef,
      currentAgentVersionId: lineage.currentAgentVersionId,
      currentVersionAvailable: !unavailable.has(lineage.currentAgentVersionId),
      knownAgentVersionIds: knownVersionIds(lineage),
      versionNumbers: versionNumbers(lineage),
      businessName: businessNameFor(state, stableAgentId),
      receptionistName: receptionistNameOf(lineage),
      conversationExists: async (id) => Boolean(state.demos?.[id] && knownVersionIds(lineage).includes(state.demos[id].agentVersionId)),
    };
  };
}
