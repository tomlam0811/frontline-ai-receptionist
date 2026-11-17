import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveKitAdapter } from '../server/livekit-adapter.js';
import { PostgresStore } from '../server/api/postgres-store.js';

const signedRoomConfigs = vi.hoisted(() => []);
vi.mock('livekit-server-sdk', async (importOriginal) => ({
  ...(await importOriginal()),
  AccessToken: class {
    addGrant() {}
    set roomConfig(config) { this.config = config; }
    async toJwt() { signedRoomConfigs.push(this.config ?? null); return 'room-scoped-token'; }
  },
}));

afterEach(() => vi.useRealTimers());

describe('Cloud runtime boundaries', () => {
  it('resolves a claimed demo result through the demo\'s own scope and the signed-in person\'s membership in it', async () => {
    const store = Object.create(PostgresStore.prototype);
    const scopeId = randomUUID(); const resourceId = randomUUID(); const demoId = randomUUID();
    store.ensureReady = vi.fn(async () => {});
    store.pool = { query: vi.fn(async () => ({ rows: [{ id: scopeId }] })) };
    const result = await store.runForRequest({ method: 'GET', headers: { cookie: `fl_auth=${'a'.repeat(64)}; fl_owner_target=agent.${resourceId}` } }, new URL(`https://frontline.example/v1/demos/${demoId}/result`), async () => 'authorized');
    expect(result).toBe('authorized');
    expect(store.pool.query.mock.calls.map(([sql]) => sql)).toEqual([expect.stringContaining('resolve_internal_demo_scope'), expect.stringContaining('resolve_frontline_member_scope')]);
    expect(store.pool.query.mock.calls[1][1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), scopeId]);
  });

  it('prefers the anonymous scope when owner and anonymous cookies coexist for the requested demo', async () => {
    const store = Object.create(PostgresStore.prototype);
    const anonymousScopeId = randomUUID(); const ownerScopeId = randomUUID();
    const resourceId = randomUUID(); const demoId = randomUUID();
    store.ensureReady = vi.fn(async () => {});
    store.pool = { query: vi.fn(async (sql) => {
      if (sql.includes('resolve_anonymous_scope')) return { rows: [{ id: anonymousScopeId }] };
      if (sql.includes('resolve_internal_demo_scope')) return { rows: [{ id: anonymousScopeId }] };
      if (sql.includes('resolve_frontline_claimed_target')) return { rows: [{ id: ownerScopeId }] };
      throw new Error(`Unexpected query: ${sql}`);
    }) };

    await store.runForRequest({ method: 'GET', headers: { cookie: `fl_workspace=${'b'.repeat(64)}; fl_auth=${'a'.repeat(64)}; fl_owner_target=agent.${resourceId}` } }, new URL(`https://frontline.example/v1/demos/${demoId}/result`), async () => {});

    expect(store.pool.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('resolve_anonymous_scope'),
      expect.stringContaining('resolve_internal_demo_scope'),
    ]);
  });

  it('asks whether the person is a member of the demo\'s own scope when the anonymous cookie does not own it', async () => {
    const store = Object.create(PostgresStore.prototype);
    const anonymousScopeId = randomUUID(); const requestedScopeId = randomUUID();
    const resourceId = randomUUID(); const demoId = randomUUID();
    store.ensureReady = vi.fn(async () => {});
    store.pool = { query: vi.fn(async (sql) => {
      if (sql.includes('resolve_anonymous_scope')) return { rows: [{ id: anonymousScopeId }] };
      if (sql.includes('resolve_internal_demo_scope')) return { rows: [{ id: requestedScopeId }] };
      if (sql.includes('resolve_frontline_member_scope')) return { rows: [{ id: requestedScopeId }] };
      throw new Error(`Unexpected query: ${sql}`);
    }) };

    await store.runForRequest({ method: 'GET', headers: { cookie: `fl_workspace=${'b'.repeat(64)}; fl_auth=${'a'.repeat(64)}; fl_owner_target=agent.${resourceId}` } }, new URL(`https://frontline.example/v1/demos/${demoId}/result`), async () => {});

    expect(store.pool.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('resolve_anonymous_scope'),
      expect.stringContaining('resolve_internal_demo_scope'),
      expect.stringContaining('resolve_frontline_member_scope'),
    ]);
  });

  it('falls back to the target cookie only when the person is not a member of the demo\'s scope', async () => {
    const store = Object.create(PostgresStore.prototype);
    const anonymousScopeId = randomUUID(); const requestedScopeId = randomUUID(); const ownerScopeId = randomUUID();
    const resourceId = randomUUID(); const demoId = randomUUID();
    store.ensureReady = vi.fn(async () => {});
    store.pool = { query: vi.fn(async (sql) => {
      if (sql.includes('resolve_anonymous_scope')) return { rows: [{ id: anonymousScopeId }] };
      if (sql.includes('resolve_internal_demo_scope')) return { rows: [{ id: requestedScopeId }] };
      if (sql.includes('resolve_frontline_member_scope')) return { rows: [{ id: null }] };
      if (sql.includes('resolve_frontline_claimed_target')) return { rows: [{ id: ownerScopeId }] };
      throw new Error(`Unexpected query: ${sql}`);
    }) };

    await store.runForRequest({ method: 'GET', headers: { cookie: `fl_workspace=${'b'.repeat(64)}; fl_auth=${'a'.repeat(64)}; fl_owner_target=agent.${resourceId}` } }, new URL(`https://frontline.example/v1/demos/${demoId}/result`), async () => {});

    expect(store.pool.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('resolve_anonymous_scope'),
      expect.stringContaining('resolve_internal_demo_scope'),
      expect.stringContaining('resolve_frontline_member_scope'),
      expect.stringContaining('resolve_frontline_claimed_target'),
    ]);
    expect(store.pool.query.mock.calls[3][1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), 'agent', resourceId]);
  });

  it('persists each due deadline before returning it to provider cleanup', async () => {
    const store = Object.create(PostgresStore.prototype);
    const due = [{ id: randomUUID() }, { id: randomUUID() }];
    store.listDueDemos = vi.fn(async () => due);
    store.persistHardEnd = vi.fn(async () => {});
    await expect(store.prepareDueHardEnds(new Date())).resolves.toEqual(due);
    expect(store.persistHardEnd.mock.calls).toEqual([[due[0], false], [due[1], false]]);
  });

  it('bounds and deduplicates a stuck provider room deletion', async () => {
    vi.useFakeTimers();
    let finishDelete = () => {};
    /** @type {Promise<void>} */
    const deletion = new Promise((resolve) => { finishDelete = resolve; });
    const deleteRoom = vi.fn(() => deletion);
    const adapter = createLiveKitAdapter({ livekitUrl: 'wss://livekit.example', apiKey: 'key', apiSecret: 'secret', api: { room: { deleteRoom } } });
    const demo = { id: randomUUID(), roomName: `frontline-demo-${randomUUID()}` };
    const first = adapter.end(demo).catch((error) => error);
    await vi.advanceTimersByTimeAsync(8_001);
    await expect(first).resolves.toMatchObject({ message: 'voice_room_delete_timeout' });
    const retry = adapter.end(demo);
    expect(deleteRoom).toHaveBeenCalledOnce();
    finishDelete();
    await retry;
  });

  it('starts a call with no LiveKit request: the join token creates the room and dispatches Blake', async () => {
    // 2026-10-03: from Railway us-west2 each server API request took about 3.2 seconds and every start timed out.
    const demo = { id: randomUUID(), agentVersionId: randomUUID(), roomName: `frontline-demo-${randomUUID()}`, generation: 1 };
    const api = { room: { listRooms: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn() }, agentDispatch: { listDispatch: vi.fn(), createDispatch: vi.fn() } };
    const adapter = createLiveKitAdapter({
      livekitUrl: 'wss://livekit.example', apiKey: 'key', apiSecret: 'secret',
      api, listDueDemos: async () => [], onHardEndDue: async () => {}, onHardEnd: async () => {},
    });
    adapter.startWatchdog();
    try {
      await adapter.sweepDueHardEnds();
      signedRoomConfigs.length = 0;
      const connection = await adapter.start(demo, { id: randomUUID(), approved: true });
      expect(connection).toMatchObject({ roomName: demo.roomName, participantIdentity: `visitor-${demo.id}`, participantToken: 'room-scoped-token', dispatchId: null });
      const [config] = signedRoomConfigs;
      expect(config).toMatchObject({ emptyTimeout: 60, departureTimeout: 15, maxParticipants: 2 });
      expect(config.agents.map(({ agentName, metadata }) => ({ agentName, metadata }))).toEqual([
        { agentName: 'frontline-bob-demo', metadata: JSON.stringify({ demoId: demo.id, agentVersionId: demo.agentVersionId, generation: 1 }) },
      ]);
      for (const calls of [api.room.listRooms, api.room.createRoom, api.agentDispatch.listDispatch, api.agentDispatch.createDispatch]) expect(calls).not.toHaveBeenCalled();

      // A reconnect token joins the same room but can never dispatch a second worker.
      signedRoomConfigs.length = 0;
      await adapter.issueParticipantToken(demo);
      expect(signedRoomConfigs).toEqual([null]);
    } finally { adapter.stopWatchdog(); }
  });

  it('accepts media readiness only for the caller with a live microphone and exactly one agent', async () => {
    const demo = { id: randomUUID(), roomName: `frontline-demo-${randomUUID()}`, participantIdentity: 'visitor' };
    const caller = { identity: 'visitor', tracks: [{ source: 2, muted: false }] };
    const bob = { identity: 'bob-job', kind: 4 };
    const room = { listParticipants: vi.fn(async () => [caller, bob]) };
    const adapter = createLiveKitAdapter({ livekitUrl: 'wss://livekit.example', apiKey: 'key', apiSecret: 'secret', api: { room } });
    expect(await adapter.isReady(demo)).toBe(true);
    expect(room.listParticipants).toHaveBeenCalledOnce();
    room.listParticipants.mockResolvedValueOnce([caller, bob, { identity: 'other-agent', kind: 4 }]);
    expect(await adapter.isReady(demo)).toBe(false);
    room.listParticipants.mockResolvedValueOnce([{ ...caller, tracks: [{ source: 2, muted: true }] }, bob]);
    expect(await adapter.isReady(demo)).toBe(false);
    room.listParticipants.mockResolvedValueOnce([caller]);
    expect(await adapter.isReady(demo)).toBe(false);
  });

  it('persists terminal authority before deletion and retries unfinished cleanup after an adapter restart', async () => {
    const demo = { id: randomUUID(), roomName: `frontline-demo-${randomUUID()}`, hardEndAt: new Date(Date.now() - 1_000).toISOString() };
    const events = [];
    const first = createLiveKitAdapter({
      livekitUrl: 'wss://livekit.example', apiKey: 'key', apiSecret: 'secret',
      api: { room: { deleteRoom: vi.fn(async () => { events.push('delete-failed'); throw new Error('provider unavailable'); }) } },
      listDueDemos: async () => [demo],
      onHardEndDue: async () => { events.push('terminal-persisted'); },
      onHardEnd: async () => { events.push('cleanup-completed'); },
    });
    await expect(first.sweepDueHardEnds()).rejects.toThrow(/deletions failed/);
    expect(events).toEqual(['terminal-persisted', 'delete-failed']);

    // A new process sees the still-closing durable row and finishes the same
    // provider cleanup without weakening or replacing the terminal outcome.
    const restarted = createLiveKitAdapter({
      livekitUrl: 'wss://livekit.example', apiKey: 'key', apiSecret: 'secret',
      api: { room: { deleteRoom: vi.fn(async () => { events.push('delete-confirmed'); }) } },
      listDueDemos: async () => [demo],
      onHardEndDue: async () => { events.push('terminal-replayed'); },
      onHardEnd: async () => { events.push('cleanup-completed'); },
    });
    await expect(restarted.sweepDueHardEnds()).resolves.toBeUndefined();
    expect(events).toEqual(['terminal-persisted', 'delete-failed', 'terminal-replayed', 'delete-confirmed', 'cleanup-completed']);
  });
});
