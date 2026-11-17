import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPaidStartGate } from '../../server/api/paid-start-gate.js';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, seedClaimedOwner } from './fixtures.js';

// PO-C9: reserveClaimed on the real paid-start gate, against real SQL functions and the real migrations.
// The gate is built the way production builds it (from environment values); only the connection is in-process.
const ENV = { FRONTLINE_VOICE_SPEND_CAP_USD: '10', FRONTLINE_VOICE_MAX_SESSION_USD: '1', FRONTLINE_VOICE_GLOBAL_CONCURRENT_MAX: '3' };

let pg; let gate; let owner;
function makeGate(environment = ENV) {
  // A store the gate accepts as Postgres, with a pool that runs on the one in-process connection.
  const store = Object.create(PostgresStore.prototype);
  store.ensureReady = async () => {};
  store.pool = { query: (sql, params) => pg.query(sql, params), connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };
  return createPaidStartGate(store, environment);
}
const complete = (reservation) => gate.complete(reservation.id);
const claimedRows = () => asOwner(pg, async () => (await pg.query('SELECT mode, state, stable_agent_id, grant_id FROM voice_start_reservations ORDER BY created_at')).rows);
const spend = () => asOwner(pg, async () => Number((await pg.query('SELECT COALESCE(sum(reserved_cents),0) AS cents FROM voice_daily_budget')).rows[0].cents));

beforeEach(async () => {
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg);
  await pg.exec('SET ROLE frontline_app');
  gate = makeGate();
});

describe('reserveClaimed', () => {
  it('reserves an owner test for a claimed scope and records the agent', async () => {
    const reservation = await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' });
    expect(reservation).toMatchObject({ approved: true, reason: 'approved', id: expect.any(String) });
    expect(await claimedRows()).toEqual([{ mode: 'owner_test', state: 'reserved', stable_agent_id: owner.agentId, grant_id: null }]);
    expect(await spend()).toBe(100);
  });

  it('allows up to agentActiveMax active calls per Blake, and a settled call frees a slot', async () => {
    const first = await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' });
    await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' });
    await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' });
    expect(await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' })).toMatchObject({ approved: false, reason: 'agent_busy' });
    await complete(first);
    expect((await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' })).approved).toBe(true);
  });

  it('stops after 15 starts per scope per day for the mode, and a released start does not count', async () => {
    // This test exercises the per-scope count limit in isolation, not the shared dollar cap (covered
    // separately below), so it needs enough daily budget for 15 owner starts, a guest start and another
    // owner's 15 starts without tripping that cap first.
    gate = makeGate({ ...ENV, FRONTLINE_VOICE_SPEND_CAP_USD: '50' });
    for (let index = 0; index < 15; index += 1) {
      const reservation = await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' });
      expect(reservation.approved, `start ${index + 1}`).toBe(true);
      await complete(reservation);
    }
    expect(await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' })).toMatchObject({ approved: false, reason: 'voice_limit_reached' });
    // The limit is per mode: guest calls have their own fifteen.
    const grant = randomUUID();
    expect((await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'shared_guest', grantId: grant })).approved).toBe(true);

    const other = await seedClaimedOwner(pg);
    await pg.exec('SET ROLE frontline_app');
    const released = await gate.reserveClaimed({ scopeId: other.scopeId, stableAgentId: other.agentId, mode: 'owner_test' });
    await gate.release(released.id);
    for (let index = 0; index < 15; index += 1) await complete(await gate.reserveClaimed({ scopeId: other.scopeId, stableAgentId: other.agentId, mode: 'owner_test' }));
  });

  it('honors the daily spend cap shared with anonymous demos', async () => {
    gate = makeGate({ ...ENV, FRONTLINE_VOICE_SPEND_CAP_USD: '2', FRONTLINE_VOICE_MAX_SESSION_USD: '1' });
    const first = await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' });
    await complete(first);
    const second = await seedClaimedOwner(pg);
    const third = await seedClaimedOwner(pg);
    await pg.exec('SET ROLE frontline_app');
    expect((await gate.reserveClaimed({ scopeId: second.scopeId, stableAgentId: second.agentId, mode: 'owner_test' })).approved).toBe(true);
    expect(await gate.reserveClaimed({ scopeId: third.scopeId, stableAgentId: third.agentId, mode: 'owner_test' })).toMatchObject({ approved: false, reason: 'voice_limit_reached' });
    expect(await spend()).toBe(200);
  });

  it('honors the global concurrent call limit across owners', async () => {
    const owners = [owner, await seedClaimedOwner(pg), await seedClaimedOwner(pg), await seedClaimedOwner(pg)];
    await pg.exec('SET ROLE frontline_app');
    const results = [];
    for (const who of owners) results.push(await gate.reserveClaimed({ scopeId: who.scopeId, stableAgentId: who.agentId, mode: 'owner_test' }));
    expect(results.map((result) => result.approved)).toEqual([true, true, true, false]);
    expect(results[3].reason).toBe('voice_limit_reached');
  });

  it('refuses a scope that is not a claimed tenant, and a scope that is not the current one', async () => {
    const anonymous = randomUUID();
    await asOwner(pg, () => pg.query("INSERT INTO ownership_scopes(id, kind, secret_hash, state, expires_at) VALUES ($1,'anonymous',$2,'anonymous', now() + interval '1 day')", [anonymous, 'a'.repeat(64)]));
    expect(await gate.reserveClaimed({ scopeId: anonymous, stableAgentId: randomUUID(), mode: 'owner_test' })).toMatchObject({ approved: false, reason: 'workspace_unavailable' });
    // Inside a caller's transaction the scope must already be set to the same id.
    await expect(pg.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [randomUUID()]);
      return gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test', tx });
    })).rejects.toThrow(/owner scope mismatch/);
  });

  it('reserves inside the caller\'s transaction, so a rollback removes the reservation', async () => {
    await expect(pg.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [owner.scopeId]);
      const reservation = await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test', tx });
      expect(reservation.approved).toBe(true);
      throw new Error('demo write failed');
    })).rejects.toThrow('demo write failed');
    expect(await claimedRows()).toEqual([]);
    expect(await spend()).toBe(0);
  });

  it('requires a grant for guest calls and none for owner tests', async () => {
    expect(await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'shared_guest' })).toMatchObject({ approved: false, reason: 'invalid_budget_configuration' });
    expect(await gate.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test', grantId: randomUUID() })).toMatchObject({ approved: false, reason: 'invalid_budget_configuration' });
    expect(await claimedRows()).toEqual([]);
  });

  it('reports the limits it applies, and leaves anonymous reserve alone', async () => {
    expect(gate.claimedLimits()).toEqual({ dailyCapCents: 1000, reservedCents: 100, globalConcurrent: 3, reservationTtlSeconds: 600, scopeDailyMax: 15, agentActiveMax: 3 });
    // reserve() still refuses a claimed scope: it is the anonymous path and it is unchanged.
    const claimedAsAnonymous = await gate.reserve({ workspaceId: owner.scopeId, preparationId: randomUUID(), mode: 'business_demo' });
    expect(claimedAsAnonymous.approved).toBe(false);
  });

  it('is unavailable without the database store, and a misconfigured gate does not exist', async () => {
    const local = createPaidStartGate({ transaction: async () => ({}) }, ENV);
    expect(await local.reserveClaimed({ scopeId: owner.scopeId, stableAgentId: owner.agentId, mode: 'owner_test' })).toMatchObject({ approved: false, reason: 'workspace_unavailable' });
    expect(local.claimedLimits()).toBeNull();
    expect(createPaidStartGate({ transaction: async () => ({}) }, {})).toBeNull();
  });
});
