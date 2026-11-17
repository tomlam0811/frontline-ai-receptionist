import { createHash } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { mapDatabaseError, problem } from './errors.js';
import { parseCookies, sha256 } from './http.js';
import { defaultId, ONBOARDING_ORIGIN } from './knowledge-model.js';
import { isSelectableSource } from './knowledge-selection.js';
import { workflowList } from './capabilities.js';
import { backfillKnowledgeLibrary, businessNameFor, ensureLineage, isDeleting, knownVersionIds, readKnowledgeBase, readLineage } from './lineage.js';
import { summarizeAgent } from './me.js';
import { assertNameFree, DEFAULT_RECEPTIONIST_NAME, parseReceptionistName } from './receptionist-name.js';
import { compileOwnerAgent, compileOwnerKnowledge } from './revision-compiler.js';

// POST /v1/me/agents: adds a receptionist to the caller's claimed business (multi-receptionist spec MR-D1, MR-D3, MR-D9).
// The new receptionist is a new stable agent id, registered as a claimed target of the same scope by the SQL function
// register_frontline_claimed_agent (migration 017), with a lineage in the scope JSON. Registration, the limit and the
// state write share one transaction, so a failure anywhere leaves neither behind.

export const RECEPTIONIST_LIMIT = 5;
export const RECEPTIONIST_LIMIT_MESSAGE = `You can have up to ${RECEPTIONIST_LIMIT} receptionists.`;
export const NAME_REQUIRED_MESSAGE = 'Name the new receptionist. Use 1 to 30 letters. Spaces, hyphens and apostrophes are fine.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_FIELDS = new Set(['name', 'siblingAgentId']);
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Finds the business the caller adds to. It is the scope of `siblingAgentId` when the caller names one of their
 * receptionists, otherwise the scope of their first claimed receptionist. Returns null-free or throws: a caller with no
 * claimed receptionist, or naming one that is not theirs, gets 404.
 */
export async function resolveCreateTarget({ db, request, siblingAgentId }) {
  const cookie = parseCookies(request).fl_auth;
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) throw problem(401, 'sign_in_required', 'Sign in again to continue.');
  if (siblingAgentId !== undefined && !(typeof siblingAgentId === 'string' && UUID.test(siblingAgentId))) throw problem(400, 'invalid_field', 'siblingAgentId: send the id of one of your receptionists.');
  const sessionHash = sha256(cookie);
  const targets = (await db.query('SELECT * FROM list_frontline_claimed_targets($1)', [sessionHash])).rows.filter((target) => target.target_kind === 'agent');
  const base = siblingAgentId ? targets.find((target) => target.target_id === siblingAgentId) : targets[0];
  if (!base) throw problem(404, 'not_found', 'Not found.');
  const inScope = targets.filter((target) => target.owner_scope_id === base.owner_scope_id).map((target) => target.target_id);
  return { sessionHash, scopeId: base.owner_scope_id, baseAgentId: base.target_id, agentIds: inScope };
}

/** The sources a new receptionist starts with: the website the owner gave during onboarding, if it is still in the library. */
export const defaultSourceIds = (library) => Object.values(library.sources ?? {}).filter((source) => source.origin === ONBOARDING_ORIGIN && isSelectableSource(source)).map((source) => source.sourceId);

/**
 * Builds the state that holds the new receptionist. Pure: the input state is not modified.
 * Version 1 is the lineage's initial revision, and its agent version id is the stable agent id, as for the claimed
 * receptionist. It compiles the default setup (every workflow on, as a first receptionist starts) from the selected sources.
 * A selection that cannot compile (its facts include no service) falls back to no source, so the receptionist still
 * gets created and shows "needs knowledge".
 */
export function addReceptionist(state, { stableAgentId, baseAgentId, name, now, newId }) {
  const baseLineage = readLineage(state, baseAgentId);
  const previousAgent = state.agents?.[baseLineage.revisions[0].agentVersionId] ?? state.agents?.[baseLineage.currentAgentVersionId];
  if (!previousAgent) throw problem(404, 'not_found', 'Not found.');
  const previous = state.knowledge?.[state.agents?.[baseLineage.currentAgentVersionId]?.knowledgeRevisionId] ?? state.knowledge?.[previousAgent.knowledgeRevisionId];
  const library = readKnowledgeBase(state, baseAgentId);
  const businessName = businessNameFor(state, baseAgentId);
  const workflows = workflowList(null);
  const compile = (sourceIds) => compileOwnerKnowledge({
    base: library, previous, reference: state.knowledge?.[library.materializedFromKnowledgeRevisionId] ?? previous, sourceIds, allowNoSources: true,
    workspaceId: previousAgent.workspaceId, businessName, workflows, now, newId,
  });
  let sourceIds = defaultSourceIds(library);
  let knowledge;
  try { knowledge = compile(sourceIds); }
  catch (error) {
    if (!sourceIds.length || error?.detailCode !== 'no_services') throw error;
    sourceIds = [];
    knowledge = compile(sourceIds);
  }
  const agent = { ...compileOwnerAgent({ previousAgent, agentVersionId: stableAgentId, knowledge, workflows }), createdAt: now.toISOString() };
  const lineage = {
    stableAgentId, name, status: 'active', businessName, sourceIds, pointerGeneration: 1, currentAgentVersionId: stableAgentId,
    revisions: [{ agentVersionId: stableAgentId, knowledgeRevisionId: knowledge.id, parentAgentVersionId: null, kind: 'initial', createdAt: now.toISOString(), createdBySubjectHash: null, lastTestedAt: null, ownerReviewedAt: null }],
  };
  return {
    ...state,
    knowledge: { ...state.knowledge, [knowledge.id]: knowledge },
    agents: { ...state.agents, [stableAgentId]: agent },
    agentLineages: { ...state.agentLineages, [stableAgentId]: lineage },
  };
}

const CREATE_ERRORS = {
  receptionist_limit: [409, 'receptionist_limit', RECEPTIONIST_LIMIT_MESSAGE],
};
const mapCreateError = (error) => {
  const entry = CREATE_ERRORS[String(error?.message ?? '')];
  return entry ? problem(entry[0], entry[1], entry[2]) : mapDatabaseError(error);
};

/**
 * @param {{db: any, target: Awaited<ReturnType<typeof resolveCreateTarget>>, body: any, idempotencyKey: string | null, voiceConfigured?: boolean, now?: Date, newId?: () => string}} input
 * @returns {Promise<{summary: any, replayed: boolean}>}
 */
export async function createReceptionist({ db, target, body, idempotencyKey, voiceConfigured = false, now = new Date(), newId = defaultId }) {
  if (!idempotencyKey) throw problem(400, 'invalid_field', 'Idempotency-Key: send a unique key with this request.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  const unknown = Object.keys(body).find((field) => !ALLOWED_FIELDS.has(field));
  if (unknown) throw problem(400, 'invalid_field', `${unknown}: this field is not accepted.`);
  const typedName = body.name === undefined ? null : parseReceptionistName(body.name);
  const payloadDigest = digestOf({ name: typedName });
  try {
    return await inOwnerScope(db, target.scopeId, async (tx) => {
      const found = (await tx.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1::uuid FOR UPDATE', [target.scopeId])).rows[0]?.state;
      if (!found) throw problem(404, 'not_found', 'Not found.');
      const summaryOf = (state, stableAgentId, replayed) => {
        const summary = summarizeAgent(state, stableAgentId, { voiceConfigured });
        if (!summary) throw problem(404, 'not_found', 'Not found.');
        return { summary: { ...summary, knownVersionIds: knownVersionIds(readLineage(state, stableAgentId)) }, replayed };
      };
      const replay = found.receptionistCreates?.[idempotencyKey];
      if (replay) {
        if (replay.payloadDigest !== payloadDigest) throw problem(409, 'idempotency_conflict', 'This request key was already used with different content.');
        return summaryOf(found, replay.stableAgentId, true);
      }
      // The limit is checked first, in SQL under a lock, so a full business answers the same whatever name was typed.
      const stableAgentId = newId();
      await tx.query('SELECT register_frontline_claimed_agent($1,$2::uuid,$3::uuid)', [target.sessionHash, target.scopeId, stableAgentId]);
      // Every receptionist of this scope needs a stored lineage before names are compared, and the library must exist.
      let state = found;
      for (const id of target.agentIds) state = ensureLineage(state, id) ?? state;
      state = backfillKnowledgeLibrary(state, target.baseAgentId);
      // A receptionist that is being deleted is not a starting point. Use the first one that is not.
      const baseAgentId = [target.baseAgentId, ...target.agentIds].find((id) => { const lineage = readLineage(state, id); return lineage && !isDeleting(lineage); });
      if (!baseAgentId) throw problem(404, 'not_found', 'Not found.');
      let name = typedName;
      if (name) assertNameFree(state, stableAgentId, name);
      else {
        try { assertNameFree(state, stableAgentId, DEFAULT_RECEPTIONIST_NAME); }
        catch (error) { throw error?.code === 'name_taken' ? problem(422, 'invalid_name', NAME_REQUIRED_MESSAGE) : error; }
        name = DEFAULT_RECEPTIONIST_NAME;
      }
      const next = addReceptionist(state, { stableAgentId, baseAgentId, name, now, newId });
      const saved = { ...next, receptionistCreates: { ...next.receptionistCreates, [idempotencyKey]: { stableAgentId, payloadDigest, createdAt: now.toISOString() } } };
      await tx.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1::uuid', [target.scopeId, JSON.stringify(saved)]);
      return summaryOf(saved, stableAgentId, false);
    });
  } catch (error) { throw mapCreateError(error); }
}
