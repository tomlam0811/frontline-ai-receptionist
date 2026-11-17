import { randomUUID } from 'node:crypto';
import { PostgresStore } from './postgres-store.js';

const RESERVATION_TTL_MS = 10 * 60 * 1000;
// Claimed owners: owner tests count by Pacific calendar day; shared guest calls count by UTC day, per kind. One
// active call per Bob. The spend cap and global concurrent cap are the same ones anonymous demos use.
// Raised from 3 to 15 on 2026-09-28 for active development testing; lower this back down before public launch.
const CLAIMED_SCOPE_DAILY_MAX = 15;
// Raised from 1 to 3 on 2026-09-28 so ending a test call doesn't block starting the next one while a room is
// still cleaning up. Keeps the safety net (a stuck room still can't grow without bound) but stops it from being
// felt as a wait during testing. Lower this back to 1 before public launch.
const CLAIMED_AGENT_ACTIVE_MAX = 3;

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function dollarsToCents(value) {
  const parsed = Number(value);
  const cents = Math.round(parsed * 100);
  return Number.isFinite(parsed) && parsed > 0 && Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function createPaidStartGate(store, environment = process.env) {
  const dailyCapCents = dollarsToCents(environment.FRONTLINE_VOICE_SPEND_CAP_USD);
  const configuredExtraDay = environment.FRONTLINE_VOICE_ONE_TIME_EXTRA_DAY_UTC;
  const parsedExtraDay = /^\d{4}-\d{2}-\d{2}$/.test(configuredExtraDay ?? '')
    ? Date.parse(`${configuredExtraDay}T00:00:00Z`) : NaN;
  const oneTimeExtraDayUtc = Number.isFinite(parsedExtraDay)
    && new Date(parsedExtraDay).toISOString().slice(0, 10) === configuredExtraDay ? configuredExtraDay : null;
  const oneTimeExtraCents = dollarsToCents(environment.FRONTLINE_VOICE_ONE_TIME_EXTRA_USD);
  // Reserve a validated upper bound for the full setup + five-minute room,
  // including speech/model charges. An average estimate cannot enforce a cap.
  const reservedCents = dollarsToCents(environment.FRONTLINE_VOICE_MAX_SESSION_USD);
  const globalConcurrent = positiveInteger(environment.FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX);
  if (!dailyCapCents || !reservedCents || !globalConcurrent || reservedCents > dailyCapCents) return null;
  const extraDailyCapCents = oneTimeExtraDayUtc && oneTimeExtraCents
    && Number.isSafeInteger(dailyCapCents + oneTimeExtraCents)
    ? dailyCapCents + oneTimeExtraCents : dailyCapCents;
  const effectiveDailyCapCents = (utcDay) => utcDay === oneTimeExtraDayUtc ? extraDailyCapCents : dailyCapCents;

  if (store instanceof PostgresStore) {
    return {
      async reserve({ workspaceId, preparationId, mode }) {
        await store.ensureReady();
        const { rows } = await store.pool.query(
          `SELECT * FROM reserve_voice_start($1::uuid,$2::uuid,$3::text,
            CASE WHEN (now() AT TIME ZONE 'UTC')::date = $4::date THEN $5::integer ELSE $6::integer END,
            $7::integer,$8::integer,$9::integer)`,
          [workspaceId, preparationId, mode, oneTimeExtraDayUtc, extraDailyCapCents, dailyCapCents, reservedCents, globalConcurrent, RESERVATION_TTL_MS / 1000],
        );
        return { id: rows[0]?.reservation_id ?? null, approved: rows[0]?.approved === true, reason: rows[0]?.reason ?? 'unavailable' };
      },
      /**
       * A voice reservation for a claimed owner (owner test call or shared guest call). It uses the same budget row and the same
       * global concurrency count as `reserve`, so one spend cap covers every kind of call. The database function needs the
       * transaction-local owner scope. Pass `tx` (a client already in that scope, such as the one that also writes the demo) to
       * reserve inside the caller's transaction; without it this opens its own short transaction.
       * @param {{scopeId: string, stableAgentId: string, mode: 'owner_test'|'shared_guest', grantId?: string|null, scopeDailyMax?: number, agentActiveMax?: number, tx?: {query: (sql: string, params: unknown[]) => Promise<{rows: any[]}>}}} input
       */
      async reserveClaimed({ scopeId, stableAgentId, mode, grantId = null, scopeDailyMax = CLAIMED_SCOPE_DAILY_MAX, agentActiveMax = CLAIMED_AGENT_ACTIVE_MAX, tx }) {
        const reserveIn = async (query) => {
          const { rows } = await query(
            `SELECT * FROM reserve_voice_start_claimed($1::uuid,$2::uuid,$3::text,$4::uuid,
              CASE WHEN (now() AT TIME ZONE 'UTC')::date = $5::date THEN $6::integer ELSE $7::integer END,
              $8::integer,$9::integer,$10::integer,$11::integer,$12::integer)`,
            [scopeId, stableAgentId, mode, grantId, oneTimeExtraDayUtc, extraDailyCapCents, dailyCapCents, reservedCents, globalConcurrent, RESERVATION_TTL_MS / 1000, scopeDailyMax, agentActiveMax],
          );
          return { id: rows[0]?.reservation_id ?? null, approved: rows[0]?.approved === true, reason: rows[0]?.reason ?? 'unavailable' };
        };
        if (tx) return reserveIn((sql, params) => tx.query(sql, params));
        await store.ensureReady();
        const client = await store.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.owner_scope_id', $1, true)", [scopeId]);
          const reservation = await reserveIn((sql, params) => client.query(sql, params));
          await client.query('COMMIT');
          return reservation;
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { /* the original error is the useful one */ }
          throw error;
        } finally { client.release(); }
      },
      /** The numbers `reserveClaimed` applies today, for the handler that reserves inside its own transaction. */
      claimedLimits: () => ({
        dailyCapCents: effectiveDailyCapCents(new Date().toISOString().slice(0, 10)), reservedCents, globalConcurrent, reservationTtlSeconds: RESERVATION_TTL_MS / 1000,
        scopeDailyMax: CLAIMED_SCOPE_DAILY_MAX, agentActiveMax: CLAIMED_AGENT_ACTIVE_MAX,
      }),
      async release(id) { await store.pool.query('SELECT settle_voice_start($1::uuid,$2::text)', [id, 'released']); },
      async complete(id) { await store.pool.query('SELECT settle_voice_start($1::uuid,$2::text)', [id, 'completed']); },
    };
  }

  // Local single-process path uses the same durable development aggregate.
  return {
    async reserve({ workspaceId, preparationId, mode }) {
      return store.transaction((state) => {
        const now = Date.now();
        const day = new Date(now).toISOString().slice(0, 10);
        state.reservations ??= {};
        for (const reservation of Object.values(state.reservations)) {
          if (reservation.state === 'reserved' && Date.parse(reservation.expiresAt) <= now) reservation.state = 'expired';
        }
        const today = Object.values(state.reservations).filter((item) => item.day === day && item.state !== 'released');
        const active = Object.values(state.reservations).filter((item) => item.state === 'reserved');
        const workspace = state.workspaces[workspaceId];
        if (!workspace || workspace.state !== 'anonymous' || Date.parse(workspace.expiresAt) <= now || !['business_demo', 'frontline_qa'].includes(mode)) return { id: null, approved: false, reason: 'workspace_unavailable' };
        if (today.reduce((sum, item) => sum + item.reservedCents, 0) + reservedCents > effectiveDailyCapCents(day) || active.length >= globalConcurrent || active.some((item) => item.workspaceId === workspaceId) || today.filter((item) => item.workspaceId === workspaceId).length >= 5) return { id: null, approved: false, reason: 'voice_limit_reached' };
        const id = randomUUID();
        state.reservations[id] = { id, workspaceId, preparationId, mode, day, reservedCents, state: 'reserved', expiresAt: new Date(now + RESERVATION_TTL_MS).toISOString() };
        return { id, approved: true, reason: 'approved' };
      });
    },
    // Claims need the Postgres store, so the single-process path has no claimed owners to reserve for.
    async reserveClaimed() { return { id: null, approved: false, reason: 'workspace_unavailable' }; },
    claimedLimits: () => null,
    async release(id) { await store.transaction((state) => { if (state.reservations?.[id]?.state === 'reserved') state.reservations[id].state = 'released'; }); },
    async complete(id) { await store.transaction((state) => { if (state.reservations?.[id]?.state === 'reserved') state.reservations[id].state = 'completed'; }); },
  };
}
