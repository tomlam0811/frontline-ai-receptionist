import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startConnectedApi } from './connected-api.js';

// PO-C8: the Python voice worker's runtime bridge against the real API code. The API answers and the worker's own
// validation and request builder run on those answers, so a drift in either side fails here. No paid provider is used.
const root = fileURLToPath(new URL('../..', import.meta.url));
const havePython = spawnSync('python3', ['--version']).status === 0;

const WORKER_BRIDGE = `
import asyncio, json, sys
sys.path.insert(0, 'workers/voice')
import runtime as rt
request = json.load(sys.stdin)
worker = rt.FrontlineRuntime.__new__(rt.FrontlineRuntime)
dispatch = request['dispatch']
worker.dispatch = rt.Dispatch(dispatch['demoId'], dispatch['agentVersionId'], dispatch['generation'])
worker.room, worker.knowledge_revision_id = request['room'], None
worker.base_url, worker.token = 'http://127.0.0.1:1', 'unused'
operation = request['operation']
if operation == 'validate_runtime':
    result = worker._validate_response('runtime', request['response'])
elif operation == 'build_assistant_turn':
    sent = []
    worker._request_sync = lambda method, action, body=None: sent.append({'method': method, 'action': action, 'body': body}) or {'seq': 1}
    turn = request['turn']
    asyncio.run(worker.assistant_turn(turn['clientTurnId'], turn['text'], turn['interrupted'], turn['stateRevision']))
    result = sent[0]
elif operation == 'validate_assistant_turn':
    result = worker._validate_response('assistant-turns', request['response'], request['body'])
elif operation == 'disabled_task_kinds':
    result = sorted(rt.disabled_task_kinds(request['enabledWorkflows']))
print(json.dumps(result))
`;

/** @param {Record<string, unknown>} request */
function worker(request) {
  const run = spawnSync('python3', ['-c', WORKER_BRIDGE], { cwd: root, input: JSON.stringify(request), encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`worker bridge failed: ${run.stderr.split('\n').filter(Boolean).at(-1)}`);
  return JSON.parse(run.stdout);
}

let ctx;
beforeEach(async () => { ctx = await startConnectedApi(); });
afterEach(() => ctx.restore());

const binding = (demo) => ({ dispatch: { demoId: demo.id, agentVersionId: demo.agentVersionId, generation: demo.generation }, room: demo.roomName });
const runtimeJson = async (demo) => (await ctx.workerCall(demo, 'runtime', {}, {}, 'GET')).json();
const transcript = async (demo) => (await ctx.ownerSql("SELECT state->'transcripts'->$2::text AS turns FROM scoped_workspace_states WHERE owner_scope_id = $1", [ctx.owner.scopeId, demo.id])).rows[0].turns ?? [];
const turn = (state, text, interrupted, clientTurnId = crypto.randomUUID()) => ({ clientTurnId, text, interrupted, stateRevision: state });

describe.skipIf(!havePython)('the voice worker against the real API', () => {
  it('accepts the runtime of an owner test call and of a shared guest call', async () => {
    const owner = await ctx.startOwnerTest();
    const ownerRuntime = await runtimeJson(owner);
    const accepted = worker({ operation: 'validate_runtime', response: ownerRuntime, ...binding(owner) });
    expect(accepted).toMatchObject({ mode: 'owner_test', callPurpose: 'owner_test', closingPolicy: 'test_summary' });
    expect(accepted.enabledWorkflows).toEqual(expect.arrayContaining(['WF-01', 'WF-06']));
    // A saved Blake runs one call at a time, so the owner test ends before the guest starts.
    expect((await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/tests/${owner.id}/end`)).status).toBe(200);
    const { demo: guest } = await ctx.startGuestCall();
    const guestRuntime = await runtimeJson(guest);
    expect(worker({ operation: 'validate_runtime', response: guestRuntime, ...binding(guest) })).toMatchObject({ mode: 'shared_guest', closingPolicy: 'guest_feedback' });
  });

  it('still rejects a runtime with an unknown key or a contradictory call policy', async () => {
    const demo = await ctx.startOwnerTest();
    const real = await runtimeJson(demo);
    for (const change of [{ privateNotes: 'x' }, { closingPolicy: 'signup_pitch' }, { closingPolicy: undefined }, { mode: 'owner_retest' }]) {
      expect(() => worker({ operation: 'validate_runtime', response: { ...real, ...change }, ...binding(demo) })).toThrow(/worker bridge failed/);
    }
  });

  it('hides the task kinds a published version turned off', async () => {
    const view = await (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json();
    const saved = await ctx.ownerClient.request('PATCH', `/v1/agents/${ctx.owner.agentId}/capabilities`, {
      body: { baseAgentVersionId: view.currentAgentVersionId, expectedPointerGeneration: view.pointerGeneration, workflows: { 'WF-05': false, 'WF-04': false } },
      headers: { 'idempotency-key': 'worker-contract-capabilities' },
    });
    expect(saved.status).toBe(200);
    const demo = await ctx.startOwnerTest((await (await ctx.ownerClient.request('GET', `/v1/agents/${ctx.owner.agentId}/summary`)).json()).currentAgentVersionId);
    const real = await runtimeJson(demo);
    expect(real.enabledWorkflows).not.toContain('WF-05');
    const accepted = worker({ operation: 'validate_runtime', response: real, ...binding(demo) });
    expect(worker({ operation: 'disabled_task_kinds', enabledWorkflows: accepted.enabledWorkflows, ...binding(demo) })).toEqual(['appointment_lookup', 'complaint']);
  });

  it('posts Blake turns in the shape PO-E17 accepts, marks a cut-off turn and treats a repeat as the same turn', async () => {
    const demo = await ctx.startOwnerTest();
    const bundle = await runtimeJson(demo);
    const post = async (body, override) => ctx.workerCall(demo, 'assistant-turns', body, override);
    const spoken = turn(bundle.stateRevision, '  Hi, I am Blake. How can I help you?  ', false);
    const first = worker({ operation: 'build_assistant_turn', turn: spoken, ...binding(demo) });
    expect(first).toEqual({ method: 'POST', action: 'assistant-turns', body: { clientTurnId: spoken.clientTurnId, text: 'Hi, I am Blake. How can I help you?', interrupted: false, expectedStateRevision: bundle.stateRevision } });
    const firstReply = await post(first.body);
    expect(firstReply.status).toBe(201);
    const firstJson = await firstReply.json();
    expect(worker({ operation: 'validate_assistant_turn', response: firstJson, body: first.body, ...binding(demo) })).toEqual({ seq: 1, replayed: false });

    const cutOff = worker({ operation: 'build_assistant_turn', turn: turn(bundle.stateRevision, 'Sure, I can get that started. Can I', true), ...binding(demo) });
    const cutOffJson = await (await post(cutOff.body)).json();
    expect(worker({ operation: 'validate_assistant_turn', response: cutOffJson, body: cutOff.body, ...binding(demo) })).toEqual({ seq: 2, replayed: false });

    const repeat = await (await post(first.body)).json();
    expect(worker({ operation: 'validate_assistant_turn', response: repeat, body: first.body, ...binding(demo) })).toEqual({ seq: 1, replayed: true });

    expect(await transcript(demo)).toMatchObject([
      { seq: 1, speaker: 'bob', text: 'Hi, I am Blake. How can I help you?', turnId: spoken.clientTurnId },
      { seq: 2, speaker: 'bob', text: 'Sure, I can get that started. Can I', interrupted: true },
    ]);
    expect((await transcript(demo))[0]).not.toHaveProperty('interrupted');
  });

  it('is refused once the session is ending, so the goodbye is not recorded', async () => {
    const demo = await ctx.startOwnerTest();
    const bundle = await runtimeJson(demo);
    const ended = await ctx.ownerClient.request('POST', `/v1/agents/${ctx.owner.agentId}/tests/${demo.id}/end`);
    expect(ended.status).toBe(200);
    const late = worker({ operation: 'build_assistant_turn', turn: turn(bundle.stateRevision, 'Thanks for testing me. Bye!', false), ...binding(demo) });
    const refused = await ctx.workerCall(demo, 'assistant-turns', late.body);
    expect(refused.status).toBe(409);
    expect((await refused.json()).title).toBe('session_ending');
    expect(await transcript(demo)).toEqual([]);
  });
});
