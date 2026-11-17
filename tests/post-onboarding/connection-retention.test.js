import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnonymousRetention } from '../../server/api/retention.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, hash, seedClaimedOwner } from './fixtures.js';

// PO-C11: the retention worker's two new sweeps, on the real migrations. The cleanup role removes global rows and
// returns counts. The runtime role prunes finished conversations inside each owner's scope. The connection is in-process;
// the roles, grants and row level security are the real ones.
let pg; let owner; let queries;
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

/** A pool that runs each statement as one database role, and records what it ran. */
const poolAs = (role) => {
  const run = async (sql, params) => { queries.push({ role, sql }); await pg.exec('RESET ROLE'); await pg.exec(`SET ROLE ${role}`); return pg.query(sql, params); };
  return { query: run, connect: async () => ({ query: run, release() {} }), end: async () => {} };
};
const demo = (id, expiresAt, state) => ({ id, state, expiresAt, mode: 'owner_test', stableAgentId: owner.agentId, agentVersionId: owner.agentId });
const scopeDemos = async () => Object.keys((await asOwner(pg, async () => (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state)).demos);

async function seed() {
  const ids = { expired: randomUUID(), live: randomUUID(), fresh: randomUUID() };
  await asOwner(pg, async () => {
    const state = { ...owner.state, demos: { [ids.expired]: demo(ids.expired, PAST, 'ended'), [ids.live]: demo(ids.live, PAST, 'active'), [ids.fresh]: demo(ids.fresh, FUTURE, 'ended') },
      callerTurns: { [ids.expired]: [{ text: 'hello' }] }, outcomes: { [ids.expired]: [{ recordId: 'r1' }] } };
    await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [owner.scopeId, JSON.stringify(state)]);
    const feedback = (expires, key) => pg.query(
      `INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
       VALUES ('owner','text','quality','text',$1,$2,$2,'owner',$3,$4,$3,$5)`, [owner.scopeId, owner.agentId, hash(key), key, expires]);
    await feedback(PAST, 'old'); await feedback(FUTURE, 'kept');
  });
  return ids;
}
const feedbackCount = () => asOwner(pg, async () => Number((await pg.query('SELECT count(*) AS n FROM frontline_feedback')).rows[0].n));

beforeEach(async () => {
  queries = [];
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg);
});

describe('post-onboarding retention sweeps', () => {
  it('removes expired feedback as the cleanup role and expired finished conversations as the runtime role, and returns counts only', async () => {
    const ids = await seed();
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    expect(await retention.sweep()).toBe(0);
    expect(await feedbackCount()).toBe(1);
    // A conversation that has not finished is never removed, even past its date. A future one stays.
    expect((await scopeDemos()).sort()).toEqual([ids.live, ids.fresh].sort());
    const state = await asOwner(pg, async () => (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0].state);
    expect(state.callerTurns[ids.expired]).toBeUndefined();
    expect(state.outcomes[ids.expired]).toBeUndefined();
    expect(state.knowledge.secret).toBeDefined();
    // A second run has nothing left to do, and the counts describe what happened.
    expect(await retention.sweepPostOnboarding()).toEqual({ feedback: 0, guestCapabilities: 0, shareGrants: 0, scopes: 0, conversations: 0, erasureJobs: 0, erasuresCompleted: 0, deletionJobs: 0, deletionsCompleted: 0, accountDeletionJobs: 0, accountDeletionsCompleted: 0, accountDeletionsStuck: 0 });
    await retention.close();
  });

  it('reports what each sweep removed', async () => {
    await seed();
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    expect(await retention.sweepPostOnboarding()).toEqual({ feedback: 1, guestCapabilities: 0, shareGrants: 0, scopes: 1, conversations: 1, erasureJobs: 0, erasuresCompleted: 0, deletionJobs: 0, deletionsCompleted: 0, accountDeletionJobs: 0, accountDeletionsCompleted: 0, accountDeletionsStuck: 0 });
  });

  it('keeps each kind of data with the role that may read it', async () => {
    await seed();
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    await retention.sweepPostOnboarding();
    const byRole = (role) => queries.filter((item) => item.role === role).map((item) => item.sql);
    expect(byRole('frontline_cleanup').every((sql) => sql.includes('cleanup_expired_post_onboarding'))).toBe(true);
    expect(byRole('frontline_app').some((sql) => sql.includes('scoped_workspace_states'))).toBe(true);
    expect(byRole('frontline_cleanup').some((sql) => sql.includes('scoped_workspace_states'))).toBe(false);
  });

  it('logs a failed account deletion sweep and still prunes conversations', async () => {
    await seed();
    await asOwner(pg, () => pg.exec('DROP FUNCTION list_pending_frontline_account_deletions(integer)'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
      expect(await retention.sweepPostOnboarding()).toMatchObject({ accountDeletionJobs: 0, scopes: 1, conversations: 1 });
      const events = logged.mock.calls.map(([line]) => JSON.parse(line));
      // Name and code only: no message, query or id.
      const failed = events.find((item) => item.event === 'account_deletion_sweep_failed');
      expect(Object.keys(failed).sort()).toEqual(['errorCode', 'errorName', 'event']);
      expect(failed.errorCode).toBe('42883');
    } finally { logged.mockRestore(); }
  });

  it('does nothing extra when the feature is off', async () => {
    await seed();
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), postOnboarding: false });
    expect(await retention.sweep()).toBe(0);
    expect(queries.some((item) => item.sql.includes('post_onboarding') || item.sql.includes('scoped_workspace_states'))).toBe(false);
    expect(await feedbackCount()).toBe(2);
    expect((await scopeDemos()).length).toBe(3);
  });

  it('follows the feature flag by default', async () => {
    const saved = process.env.FRONTLINE_POST_ONBOARDING;
    try {
      delete process.env.FRONTLINE_POST_ONBOARDING;
      const off = createAnonymousRetention({ pool: poolAs('frontline_cleanup') });
      await off.sweep();
      expect(queries.some((item) => item.sql.includes('post_onboarding'))).toBe(false);
      process.env.FRONTLINE_POST_ONBOARDING = 'on';
      expect(() => createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimeConnectionString: '' })).toThrow(/DATABASE_URL/);
    } finally {
      if (saved === undefined) delete process.env.FRONTLINE_POST_ONBOARDING; else process.env.FRONTLINE_POST_ONBOARDING = saved;
    }
  });

  it('refuses to start when the conversation sweep would use the cleanup role', async () => {
    const retention = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_cleanup'), postOnboarding: true });
    await expect(retention.start()).rejects.toThrow(/unprivileged runtime database role/);
    const ready = createAnonymousRetention({ pool: poolAs('frontline_cleanup'), runtimePool: poolAs('frontline_app'), postOnboarding: true });
    await ready.start();
    expect(ready.healthy()).toBe(true);
    await ready.close();
  });
});
