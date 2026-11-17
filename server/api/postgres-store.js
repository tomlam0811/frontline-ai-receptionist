import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { forceTerminal } from './workflows.js';

const emptyState = () => ({ workspaces: {}, preparations: {}, knowledge: {}, agents: {}, demos: {}, requests: {}, workflows: {}, callerTurns: {}, outcomes: {}, cases: {}, lookups: {}, receipts: {} });
const context = new AsyncLocalStorage();
const capabilityHash = (token) => createHash('sha256').update(token).digest('hex');
// PostgreSQL rejects the JSON escape for U+0000. External text can reach
// values or member names; refuse a renamed-key collision rather than lose data.
function postgresSafeJson(value) {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(postgresSafeJson);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return postgresSafeJson(value.toJSON());
    const clean = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const safeKey = key.replaceAll('\u0000', '');
      if (Object.hasOwn(clean, safeKey)) throw new Error('Postgres JSON key collision after sanitization.');
      clean[safeKey] = postgresSafeJson(item);
    }
    return clean;
  }
  return value;
}

// Owner test calls and shared guest calls live in a claimed scope and are reserved through reserve_voice_start_claimed.
const isNeverStartedClaimedCall = (demo) => ['owner_test', 'shared_guest'].includes(demo.mode) && !demo.startedAt;

export const serializePostgresState = (state) => JSON.stringify(postgresSafeJson(state));

export class PostgresStore {
  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is required for PostgresStore.');
    this.pool = new pg.Pool({ connectionString, max: 8 });
    // An idle client's connection can drop for reasons outside any query (the server restarting,
    // a network blip). Node treats an unhandled 'error' event on an EventEmitter as fatal, so without
    // this listener that drop crashes the whole process instead of just failing the next query.
    this.pool.on('error', (error) => {
      console.error(JSON.stringify({ event: 'postgres_pool_error', errorName: error?.name ?? 'Error',
        errorCode: typeof error?.code === 'string' ? error.code : null }));
    });
    this.ready = null;
  }

  ensureReady() {
    if (!this.ready) this.ready = this.checkRole().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  async checkRole() {
    const { rows } = await this.pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    if (!rows.length || rows[0].rolsuper || rows[0].rolbypassrls) throw new Error('Frontline runtime database role must not bypass row-level security.');
    const owners = await this.pool.query("SELECT relname FROM pg_class WHERE relname IN ('scoped_workspace_states', 'voice_start_reservations', 'demo_deadline_ledger', 'preparation_jobs') AND pg_get_userbyid(relowner) = current_user");
    if (owners.rows.length) throw new Error('Frontline runtime database role must not own protected tables.');
  }

  async runForRequest(request, url, callback) {
    await this.ensureReady();
    const cookie = String(request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('fl_workspace='));
    const token = cookie?.slice('fl_workspace='.length);
    let scopeId = null;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const result = await this.pool.query('SELECT resolve_anonymous_scope($1) AS id', [capabilityHash(token)]);
      scopeId = result.rows[0]?.id ?? null;
    }
    const claimedTarget = url.pathname.match(/^\/v1\/(agents|workspaces)\/([0-9a-f-]{36})(?:\/|$)/);
    if (claimedTarget) {
      // Claimed resources must use the authenticated tenant scope even when
      // this browser also has an unrelated anonymous trial cookie.
      scopeId = null;
      const authCookie = String(request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('fl_auth='))?.slice('fl_auth='.length);
      if (authCookie && /^[a-f0-9]{64}$/.test(authCookie)) {
        const kind = claimedTarget[1] === 'agents' ? 'agent' : 'workspace';
        const result = await this.pool.query('SELECT resolve_frontline_claimed_target($1,$2,$3::uuid) AS id', [capabilityHash(authCookie), kind, claimedTarget[2]]);
        scopeId = result.rows[0]?.id ?? null;
      }
    }
    const ownerDemoResult = request.method === 'GET' && url.pathname.match(/^\/v1\/demos\/([0-9a-f-]{36})\/result$/);
    if (ownerDemoResult) {
      const authCookie = String(request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('fl_auth='))?.slice('fl_auth='.length);
      const targetCookie = String(request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('fl_owner_target='))?.slice('fl_owner_target='.length);
      const target = targetCookie?.match(/^(agent|workspace)\.([0-9a-f-]{36})$/);
      if (authCookie && /^[a-f0-9]{64}$/.test(authCookie)) {
        // The demo names its own scope. A person can own several claimed scopes, and a scope several receptionists,
        // while the target cookie names only the one claimed last, so the cookie is a hint and never the deciding fact.
        const demoScope = (await this.pool.query('SELECT resolve_internal_demo_scope($1::uuid) AS id', [ownerDemoResult[1]])).rows[0]?.id ?? null;
        // Prefer a valid anonymous capability for this exact demo. A stale
        // signed-in target hint must not shadow a newer anonymous demo.
        if (!(scopeId && demoScope === scopeId)) {
          const member = demoScope ? (await this.pool.query('SELECT resolve_frontline_member_scope($1,$2::uuid) AS id', [capabilityHash(authCookie), demoScope])).rows[0]?.id : null;
          if (member) scopeId = member;
          else if (target) {
            const result = await this.pool.query('SELECT resolve_frontline_claimed_target($1,$2,$3::uuid) AS id', [capabilityHash(authCookie), target[1], target[2]]);
            scopeId = result.rows[0]?.id ?? null;
          }
        }
      }
    }
    // Guest, signed-in home and builder routes never run under a store scope (PO-C2). They reach the
    // database only through their own scoped SQL functions, so a stray trial cookie or a valid owner
    // session on one of these paths cannot make store.read() return another owner's state.
    if (/^\/v1\/(shared|me|builder)(\/|$)/.test(url.pathname)) scopeId = null;
    const internal = url.pathname.match(/^\/v1\/internal\/demos\/([0-9a-f-]{36})\//);
    if (internal) {
      // Worker routes are bound to the demo, never to a browser cookie.
      const result = await this.pool.query('SELECT resolve_internal_demo_scope($1::uuid) AS id', [internal[1]]);
      scopeId = result.rows[0]?.id ?? null;
    }
    return context.run({ scopeId }, callback);
  }

  async read() {
    await this.ensureReady();
    const scopeId = context.getStore()?.scopeId;
    if (!scopeId) return emptyState();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [scopeId]);
      const { rows } = await client.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [scopeId]);
      await client.query('COMMIT');
      return rows[0]?.state ?? emptyState();
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async transaction(callback, options = {}) {
    await this.ensureReady();
    const requestContext = context.getStore();
    if (!requestContext) throw new Error('PostgresStore requires a request scope.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (requestContext.scopeId) {
        await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [requestContext.scopeId]);
        const result = await client.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1 FOR UPDATE', [requestContext.scopeId]);
        if (!result.rows.length) throw new Error('Scoped workspace state is missing.');
        const state = result.rows[0].state;
        const output = await callback(state);
        await client.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1', [requestContext.scopeId, serializePostgresState(state)]);
        await this.indexDemos(client, requestContext.scopeId, state);
        if (options.beforeCommit) await options.beforeCommit(client, state, output);
        await client.query('COMMIT');
        return output;
      }

      const state = emptyState();
      const output = await callback(state);
      const workspaces = Object.values(state.workspaces);
      if (workspaces.length !== 1) throw new Error('A new transaction must create exactly one workspace.');
      const workspace = workspaces[0];
      await client.query('INSERT INTO ownership_scopes (id, kind, secret_hash, state, expires_at) VALUES ($1, $2, $3, $4, $5)', [workspace.id, 'anonymous', workspace.secretHash, 'anonymous', workspace.expiresAt]);
      await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [workspace.id]);
      await client.query('INSERT INTO scoped_workspace_states (owner_scope_id, state) VALUES ($1, $2::jsonb)', [workspace.id, serializePostgresState(state)]);
      await this.indexDemos(client, workspace.id, state);
      if (options.beforeCommit) await options.beforeCommit(client, state, output);
      await client.query('COMMIT');
      requestContext.scopeId = workspace.id;
      return output;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async indexDemos(client, scopeId, state) {
    for (const [id, demo] of Object.entries(state.demos)) {
      await client.query('SELECT index_internal_demo_scope($1::uuid,$2::uuid)', [id, scopeId]);
      const deadline = demo.hardEndAt ?? demo.setupDeadlineAt;
      if (deadline && demo.reservationId) {
        // Terminal application state is committed before provider cleanup. Do
        // not close the durable deadline until room deletion is confirmed.
        if (['ended', 'failed'].includes(demo.state) && demo.voiceCleanupCompleted !== true) continue;
        await client.query('SELECT upsert_demo_deadline($1::uuid,$2::uuid,$3::text,$4::uuid,$5::timestamptz,$6::text,$7::text)', [id, scopeId, demo.roomName, demo.reservationId, deadline, demo.hardEndAt ? 'active' : 'setup', demo.voiceCleanupCompleted === true ? 'ended' : 'active']);
      }
    }
  }

  async listDueDemos(now = new Date()) {
    await this.ensureReady();
    const { rows } = await this.pool.query('SELECT * FROM list_due_demo_deadlines($1::timestamptz)', [now]);
    return rows.map((row) => ({ id: row.demo_id, ownerScopeId: row.owner_scope_id, roomName: row.room_name, reservationId: row.reservation_id, hardEndAt: row.deadline_at, deadlinePhase: row.phase }));
  }

  async prepareDueHardEnds(now = new Date()) {
    const prepared = [];
    for (const demo of await this.listDueDemos(now)) {
      try { await this.persistHardEnd(demo, false); prepared.push(demo); }
      catch { /* A later watchdog sweep retries the still-active deadline row. */ }
    }
    return prepared;
  }

  async persistHardEnd(demo, settle = false) {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [demo.ownerScopeId]);
      const { rows } = await client.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1 FOR UPDATE', [demo.ownerScopeId]);
      const state = rows[0]?.state;
      const current = state?.demos?.[demo.id];
      const pinnedDeadline = demo.deadlinePhase === 'setup' ? current?.setupDeadlineAt : current?.hardEndAt;
      if (!current || current.roomName !== demo.roomName || pinnedDeadline !== new Date(demo.hardEndAt).toISOString() || current.reservationId !== demo.reservationId) throw new Error('Hard-end demo binding mismatch.');
      if (!['ended', 'failed'].includes(current.state)) forceTerminal(state, current, demo.deadlinePhase === 'setup' ? 'setup_timeout' : 'hard_end_elapsed', demo.deadlinePhase === 'setup' ? 'failed' : 'ended');
      if (settle) current.voiceCleanupCompleted = true;
      await client.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1', [demo.ownerScopeId, serializePostgresState(state)]);
      await this.settleClaimedCall(client, current, settle);
      if (settle) {
        await this.indexDemos(client, demo.ownerScopeId, state);
        // A claimed call that never started is not charged. Every other call keeps its spend.
        await client.query('SELECT settle_voice_start($1::uuid,$2::text)', [demo.reservationId, isNeverStartedClaimedCall(current) ? 'released' : 'completed']);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async finalizeHardEnd(demo) { return this.persistHardEnd(demo, true); }

  // Share link bookkeeping for owner scope demos that already reached a terminal state (PO-C1).
  // A started call consumes its link. A call that never started returns the link to unused, and
  // only once the room is confirmed gone (settle). Both are fenced by the demo's lease generation.
  async settleClaimedCall(client, demo, roomGone) {
    if (!demo.shareGrantId || !['ended', 'failed'].includes(demo.state)) return;
    if (demo.startedAt) {
      await client.query('SELECT share_mark_consumed($1::uuid,$2::integer,$3::text)', [demo.shareGrantId, demo.leaseGeneration, demo.terminalReason ?? 'ended']);
    } else if (roomGone) {
      await client.query('SELECT share_release_reservation($1::uuid,$2::integer)', [demo.shareGrantId, demo.leaseGeneration]);
    }
  }

  /**
   * Ends one demo in an owner scope because something other than the call ended it, such as a
   * revoked or expired share link. Uses the same forced terminal state as the hard-end watchdog.
   * Returns the ended demo, or null when there is no such demo.
   */
  async endClaimedDemo({ ownerScopeId, demoId, reason }) {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [ownerScopeId]);
      const { rows } = await client.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1 FOR UPDATE', [ownerScopeId]);
      const state = rows[0]?.state;
      const current = state?.demos?.[demoId];
      if (!current || !['owner_test', 'shared_guest'].includes(current.mode)) { await client.query('ROLLBACK'); return null; }
      if (!['ended', 'failed'].includes(current.state)) forceTerminal(state, current, reason, 'ended');
      await client.query('UPDATE scoped_workspace_states SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE owner_scope_id = $1', [ownerScopeId, serializePostgresState(state)]);
      await this.settleClaimedCall(client, current, false);
      await this.indexDemos(client, ownerScopeId, state);
      await client.query('COMMIT');
      return { ...current, ownerScopeId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async close() { await this.pool.end(); }
}
