import { randomUUID } from 'node:crypto';
import { inOwnerScope } from './database.js';
import { mapDatabaseError, problem } from './errors.js';
import { sha256 } from './http.js';

export const FEEDBACK_CATEGORIES = ['business_context', 'quality', 'functionality', 'other'];
export const FEEDBACK_SOURCES = ['owner', 'guest'];
export const FEEDBACK_STATUSES = ['new', 'reviewed', 'resolved'];
export const FEEDBACK_TEXT_MAX = 10_000;
export const FEEDBACK_RETENTION_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;

const invalid = (field, message) => problem(400, 'invalid_field', `${field}: ${message}`);

/** Validates a submit body and returns the normalized fields. Never throws on shape it can repair (trim). */
export function parseFeedbackSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'invalid_field', 'Send a JSON object.');
  if (!FEEDBACK_CATEGORIES.includes(body.category)) throw invalid('category', `use one of ${FEEDBACK_CATEGORIES.join(', ')}.`);
  if (!['text', 'dictation'].includes(body.inputMethod)) throw invalid('inputMethod', 'use text or dictation.');
  if (typeof body.text !== 'string') throw invalid('text', 'send the feedback as text.');
  const text = body.text.trim();
  if (!text) throw invalid('text', 'write something first.');
  if (text.length > FEEDBACK_TEXT_MAX) throw problem(413, 'input_too_large', `Use up to ${FEEDBACK_TEXT_MAX.toLocaleString('en-US')} characters.`);
  let originalTranscript = null;
  if (body.originalTranscript != null) {
    if (body.inputMethod !== 'dictation' || typeof body.originalTranscript !== 'string' || body.originalTranscript.length > FEEDBACK_TEXT_MAX) throw invalid('originalTranscript', 'only dictation may carry the original transcript, up to 10,000 characters.');
    originalTranscript = body.originalTranscript;
  }
  for (const field of ['conversationId', 'agentVersionId']) {
    if (body[field] != null && !UUID.test(body[field])) throw invalid(field, 'use an id from this agent.');
  }
  return { category: body.category, inputMethod: body.inputMethod, text, originalTranscript, conversationId: body.conversationId ?? null, agentVersionId: body.agentVersionId ?? null };
}

export function parseIdempotencyKey(header) {
  if (header == null || header === '') return null;
  if (!KEY.test(header)) throw problem(400, 'invalid_field', 'Idempotency-Key must be 1 to 128 letters, digits, underscores or dashes.');
  return header;
}

const canonicalDigest = (fields) => sha256(JSON.stringify([fields.category, fields.inputMethod, fields.text, fields.originalTranscript, fields.conversationId, fields.agentVersionId]));

/**
 * Stores one feedback submission. `actor` is resolved by the caller from the owner
 * or guest capability: { scopeId, stableAgentId, currentAgentVersionId, knownAgentVersionIds,
 * creatorKind: 'owner'|'guest_session', creatorRef (sha256 hex), conversationExists(id) }.
 */
export async function submitFeedback({ db, actor, body, idempotencyKey, now = new Date(), retentionDays = FEEDBACK_RETENTION_DAYS }) {
  const fields = parseFeedbackSubmission(body);
  const agentVersionId = fields.agentVersionId ?? actor.currentAgentVersionId;
  if (!actor.knownAgentVersionIds.includes(agentVersionId)) throw invalid('agentVersionId', 'use a version of this agent.');
  const conversationId = fields.conversationId ?? actor.conversationId ?? null;
  if (fields.conversationId && !(await actor.conversationExists(fields.conversationId))) throw problem(422, 'conversation_not_found', 'That conversation is not available.');
  const key = idempotencyKey ?? `auto_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + retentionDays * 86_400_000).toISOString();
  try {
    const row = await inOwnerScope(db, actor.scopeId, async (tx) => {
      const { rows } = await tx.query(
        'SELECT * FROM submit_feedback($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15::uuid)',
        [actor.scopeId, actor.stableAgentId, agentVersionId, conversationId,
          actor.creatorKind === 'owner' ? 'owner' : 'guest', fields.inputMethod, fields.category, fields.text, fields.originalTranscript,
          actor.creatorKind, actor.creatorRef, key, canonicalDigest({ ...fields, agentVersionId }), expiresAt, actor.linkedKnowledgeUpdateId ?? null]);
      return rows[0];
    });
    return { receipt: { feedbackId: row.id, receivedAt: new Date(row.created_at).toISOString(), category: row.category, status: row.status }, replayed: row.replayed };
  } catch (error) { throw mapDatabaseError(error); }
}

// ---------------------------------------------------------------- builder reads

const ISO_MICROS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ISO_UPDATED = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function encodeCursor(createdAt, id) { return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url'); }
export function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value.c !== 'string' || Number.isNaN(Date.parse(value.c)) || !UUID.test(value.i)) throw new Error('shape');
    return { createdAt: value.c, id: value.i };
  } catch { throw problem(400, 'invalid_filter', 'cursor: use the nextCursor value from a previous response.'); }
}

/** Validates builder query filters into SQL parameters. */
export function parseSearchFilters(query) {
  const filters = {};
  const text = (name, max) => {
    const value = query[name];
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.length > max) throw problem(400, 'invalid_filter', `${name}: too long.`);
    return value;
  };
  const oneOf = (name, allowed) => {
    const value = text(name, 40);
    if (value != null && !allowed.includes(value)) throw problem(400, 'invalid_filter', `${name}: use one of ${allowed.join(', ')}.`);
    return value;
  };
  const uuid = (name) => {
    const value = text(name, 36);
    if (value != null && !UUID.test(value)) throw problem(400, 'invalid_filter', `${name}: use a UUID.`);
    return value;
  };
  filters.q = text('q', 200);
  filters.category = oneOf('category', FEEDBACK_CATEGORIES);
  filters.source = oneOf('source', FEEDBACK_SOURCES);
  filters.status = oneOf('status', FEEDBACK_STATUSES);
  filters.agentId = uuid('agentId');
  filters.agentVersionId = uuid('agentVersionId');
  filters.conversationId = uuid('conversationId');
  const since = text('since', 40);
  if (since != null && Number.isNaN(Date.parse(since))) throw problem(400, 'invalid_filter', 'since: use an ISO-8601 date.');
  filters.since = since == null ? null : new Date(since).toISOString();
  const limit = text('limit', 6);
  if (limit != null && !/^\d{1,3}$/.test(limit)) throw problem(400, 'invalid_filter', 'limit: use a whole number from 1 to 100.');
  filters.limit = Math.min(Math.max(limit == null ? 25 : Number(limit), 1), 100);
  const cursor = text('cursor', 300);
  filters.cursor = cursor == null ? null : decodeCursor(cursor);
  return filters;
}

function toRecord(row) {
  return {
    schemaVersion: row.schema_version, id: row.id, createdAt: row.created_at_iso, updatedAt: row.updated_at_iso,
    source: row.source, inputMethod: row.input_method, category: row.category, submittedText: row.submitted_text,
    originalTranscript: row.original_transcript, agentId: row.stable_agent_id, agentVersionId: row.agent_version_id,
    conversationId: row.conversation_id, linkedKnowledgeUpdateId: row.linked_knowledge_update_id,
    status: row.status, revision: row.revision, derivedSummary: row.derived_summary,
    ...(row.events ? { events: row.events } : {}),
  };
}

const auth = (credential) => (credential.kind === 'credential' ? [sha256(credential.token), null] : [null, sha256(credential.sessionToken)]);

/** credential is { kind: 'credential', token } or { kind: 'session', sessionToken }. */
export async function searchFeedback({ db, credential, query }) {
  const filters = parseSearchFilters(query);
  try {
    const { rows } = await db.query(
      `SELECT *, ${ISO_MICROS} AS created_at_iso, ${ISO_UPDATED} AS updated_at_iso
         FROM builder_search_feedback($1,$2,$3,$4,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10::timestamptz,$11::timestamptz,$12::uuid,$13)`,
      [...auth(credential), filters.q, filters.category, filters.agentId, filters.agentVersionId, filters.conversationId,
        filters.source, filters.status, filters.since, filters.cursor?.createdAt ?? null, filters.cursor?.id ?? null, filters.limit]);
    const page = rows.slice(0, filters.limit).map(toRecord);
    const last = page[page.length - 1];
    return { schemaVersion: 1, records: page, nextCursor: rows.length > filters.limit && last ? encodeCursor(last.createdAt, last.id) : null };
  } catch (error) { throw mapDatabaseError(error); }
}

export async function getFeedback({ db, credential, id }) {
  if (!UUID.test(id)) throw problem(404, 'not_found', 'Not found.');
  try {
    const { rows } = await db.query(
      `SELECT *, ${ISO_MICROS} AS created_at_iso, ${ISO_UPDATED} AS updated_at_iso FROM builder_get_feedback($1,$2,$3::uuid)`,
      [...auth(credential), id]);
    if (!rows[0]) throw problem(404, 'not_found', 'Not found.');
    return toRecord(rows[0]);
  } catch (error) { throw mapDatabaseError(error); }
}

/** Session only. A read-only credential is rejected before reaching the database. */
export async function updateFeedbackStatus({ db, credential, id, body }) {
  if (credential.kind !== 'session') throw problem(403, 'credential_read_only', 'This credential can only read feedback.');
  if (!UUID.test(id)) throw problem(404, 'not_found', 'Not found.');
  if (!Number.isInteger(body?.expectedRevision) || !FEEDBACK_STATUSES.includes(body?.status)) throw invalid('status', 'send expectedRevision and a status of new, reviewed or resolved.');
  try {
    const { rows } = await db.query('SELECT * FROM builder_update_feedback_status($1,$2::uuid,$3,$4)', [sha256(credential.sessionToken), id, body.expectedRevision, body.status]);
    return getFeedback({ db, credential, id: rows[0].id });
  } catch (error) { throw mapDatabaseError(error); }
}
