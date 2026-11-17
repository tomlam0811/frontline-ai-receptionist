import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromPglite } from '../../server/api/post-onboarding/database.js';
import { pruneExpiredDemos, sweepExpiredConversations } from '../../server/api/post-onboarding/retention.js';
import { asCleanup, createMigratedDatabase } from './database.js';
import { asOwner, hash, seedClaimedOwner } from './fixtures.js';

let pg; let db;
const NOW = new Date('2026-11-01T00:00:00.000Z');
const past = '2026-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = fromPglite(pg);
});
afterAll(async () => { await pg.close(); });

const demo = (id, expiresAt, state = 'ended') => ({ id, state, expiresAt, mode: 'owner_test', agentVersionId: randomUUID() });
const stateWith = (demos) => {
  const state = { demos: {}, callerTurns: {}, outcomes: {}, cases: {}, workflows: {}, requests: {}, transcripts: {}, recaps: {}, lookups: {}, receipts: {} };
  demos.forEach((item, index) => {
    state.demos[item.id] = item;
    state.callerTurns[item.id] = [{ text: 'hello' }];
    state.outcomes[item.id] = [{ recordId: `r${index}` }];
    state.cases[item.id] = [{ recordId: `c${index}` }];
    state.requests[item.id] = { note: 'x' };
    state.transcripts[item.id] = [{ text: 'bob' }]; state.recaps[item.id] = { text: 'A recap.', entryCount: 1 };
    state.workflows[item.id] = { workflowInstanceId: `wf-${item.id}` };
    state.lookups[`op-${item.id}`] = { outcome: { demoId: item.id } };
    state.receipts[`op2-${item.id}`] = { workflowInstanceId: `wf-${item.id}` };
  });
  return state;
};

describe('pruneExpiredDemos', () => {
  it('removes an expired finished conversation with everything stored about it and keeps the rest', () => {
    const old = randomUUID(); const fresh = randomUUID();
    const { state, removed } = pruneExpiredDemos(stateWith([demo(old, past), demo(fresh, future)]), NOW);
    expect(removed).toBe(1);
    for (const key of ['demos', 'callerTurns', 'outcomes', 'cases', 'requests', 'transcripts', 'recaps', 'workflows']) expect(Object.keys(state[key])).toEqual([fresh]);
    expect(Object.keys(state.lookups)).toEqual([`op-${fresh}`]);
    expect(Object.keys(state.receipts)).toEqual([`op2-${fresh}`]);
  });

  it('never removes a conversation that has not finished, or one with no expiry', () => {
    const live = randomUUID(); const open = randomUUID();
    const input = stateWith([demo(live, past, 'active'), { ...demo(open, past), expiresAt: undefined }]);
    const result = pruneExpiredDemos(input, NOW);
    expect(result.removed).toBe(0);
    expect(result.state).toBe(input);
  });
});

describe('sweeping conversations', () => {
  it('prunes only scopes that have expired conversations and reports counts', async () => {
    const stale = await seedClaimedOwner(pg);
    const clean = await seedClaimedOwner(pg);
    const old = randomUUID(); const fresh = randomUUID();
    await asOwner(pg, async () => {
      await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [stale.scopeId, JSON.stringify({ ...stale.state, ...stateWith([demo(old, past), demo(fresh, future)]) })]);
      await pg.query('UPDATE scoped_workspace_states SET state = $2::jsonb WHERE owner_scope_id = $1', [clean.scopeId, JSON.stringify({ ...clean.state, ...stateWith([demo(randomUUID(), future)]) })]);
    });
    await pg.exec('SET ROLE frontline_app');
    const listed = (await pg.query('SELECT list_scopes_with_expired_post_onboarding_demos(50) AS id')).rows.map((row) => row.id);
    expect(listed).toEqual([stale.scopeId]);
    expect(await sweepExpiredConversations({ db, now: NOW })).toEqual({ scopes: 1, conversations: 1 });
    const after = await asOwner(pg, async () => (await pg.query('SELECT state FROM scoped_workspace_states WHERE owner_scope_id = $1', [stale.scopeId])).rows[0].state);
    expect(Object.keys(after.demos)).toEqual([fresh]);
    expect(after.knowledge.secret).toBeDefined();
    expect(await sweepExpiredConversations({ db, now: NOW })).toEqual({ scopes: 0, conversations: 0 });
    // The listing must not leave one owner's scope selected on the connection.
    expect((await pg.query("SELECT current_setting('app.owner_scope_id', true) AS scope")).rows[0].scope ?? '').toBe('');
  });
});

describe('cleanup_expired_post_onboarding', () => {
  it('deletes only what is past retention, as the cleanup role, and returns counts', async () => {
    const owner = await seedClaimedOwner(pg);
    await asOwner(pg, async () => {
      const insertFeedback = (expires, key) => pg.query(
        `INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
         VALUES ('owner','text','quality','text',$1,$2,$2,'owner',$3,$4,$3,$5)`, [owner.scopeId, owner.agentId, hash(key), key, expires]);
      await insertFeedback('2026-01-01T00:00:00Z', 'old');
      await insertFeedback('2099-01-01T00:00:00Z', 'kept');
      const grant = (status, endedAt, key) => pg.query(
        `INSERT INTO frontline_share_grants(owner_scope_id, stable_agent_id, agent_version_id, token_hash, status, created_by_ref, expires_at, idempotency_key, payload_digest, consumed_at)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$5,$8) RETURNING id`, [owner.scopeId, owner.agentId, hash(`t-${key}`), status, hash(key), endedAt ?? '2099-01-01T00:00:00Z', key, status === 'consumed' ? endedAt : null]);
      const oldGrant = (await grant('consumed', '2026-01-01T00:00:00Z', 'g-old')).rows[0].id;
      await grant('consumed', new Date().toISOString(), 'g-recent');
      await grant('unused', null, 'g-live');
      await pg.query("INSERT INTO frontline_guest_capabilities(capability_hash, grant_id, kind, expires_at) VALUES ($1,$2,'session','2026-01-02T00:00:00Z')", [hash('cap'), oldGrant]);
    });
    await pg.exec('RESET ROLE');
    const counts = await asCleanup(pg, async () => (await pg.query('SELECT * FROM cleanup_expired_post_onboarding(100)')).rows[0]);
    expect(counts).toEqual({ feedback: 1, guest_capabilities: 1, share_grants: 1 });
    const left = await asOwner(pg, async () => ({
      feedback: (await pg.query('SELECT expires_at FROM frontline_feedback WHERE owner_scope_id = $1', [owner.scopeId])).rows.length,
      grants: (await pg.query('SELECT token_hash FROM frontline_share_grants WHERE owner_scope_id = $1', [owner.scopeId])).rows.length,
    }));
    expect(left).toEqual({ feedback: 1, grants: 2 });
    await expect(asCleanup(pg, () => pg.query('SELECT * FROM cleanup_expired_post_onboarding(0)'))).rejects.toThrow(/between 1 and 500/);
    await expect(asCleanup(pg, () => pg.query('SELECT * FROM frontline_feedback'))).rejects.toThrow(/permission denied/);
  });
});
