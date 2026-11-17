import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApiHandler } from '../../server/api/service.js';
import { DevelopmentStore } from '../../server/api/store.js';

const token = 'fixture_voice_token_000000000000000000000000';
process.env.FRONTLINE_VOICE_SERVICE_TOKEN = token;
const store = new DevelopmentStore(process.argv[2]);
let metadata;

const classifyTurn = async (text) => {
  const value = text.toLowerCase();
  if (value.includes('human')) return { status: 'classified', workflowId: 'WF-06', dialogueAct: 'request_human', confidence: .99, escalationReason: 'human_preference', model: 'jev-1.13.0' };
  if (value.includes('hours')) return { status: 'classified', workflowId: 'WF-01', dialogueAct: 'question', confidence: .99, escalationReason: null, model: 'jev-1.13.0' };
  return { status: 'classified', workflowId: 'WF-03', dialogueAct: /^(yes|correct)/i.test(text) ? 'affirm' : value.includes('change') ? 'correct' : 'provide_fields', confidence: .99, escalationReason: null, model: 'jev-1.13.0' };
};

async function reset() {
  const now = Date.now();
  const ids = Object.fromEntries(['workspaceId', 'preparationId', 'knowledgeRevisionId', 'agentVersionId', 'demoId'].map((key) => [key, randomUUID()]));
  const workspaceToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(now + 3_600_000).toISOString();
  await store.transaction((state) => {
    Object.assign(state, { workspaces: {}, preparations: {}, knowledge: {}, agents: {}, demos: {}, workflows: {}, callerTurns: {}, outcomes: {}, cases: {}, lookups: {}, receipts: {} });
    state.workspaces[ids.workspaceId] = { id: ids.workspaceId, state: 'anonymous', secretHash: createHash('sha256').update(workspaceToken).digest('hex'), expiresAt };
    state.preparations[ids.preparationId] = { id: ids.preparationId, workspaceId: ids.workspaceId, revision: 1, profile: { businessName: 'Fixture Wash' }, agentVersionId: ids.agentVersionId, knowledgeRevisionId: ids.knowledgeRevisionId, expiresAt };
    state.knowledge[ids.knowledgeRevisionId] = { id: ids.knowledgeRevisionId, workspaceId: ids.workspaceId, facts: [], groupedFacts: [], classifiedPassages: [], expiresAt };
    state.agents[ids.agentVersionId] = { id: ids.agentVersionId, workspaceId: ids.workspaceId, knowledgeRevisionId: ids.knowledgeRevisionId, capabilityManifest: {}, expiresAt };
    state.demos[ids.demoId] = { id: ids.demoId, workspaceId: ids.workspaceId, preparationId: ids.preparationId, preparationRevision: 1, mode: 'business_demo', callArchitectureVersion: process.env.FRONTLINE_CALL_ARCHITECTURE || 'legacy-v1', agentVersionId: ids.agentVersionId, knowledgeRevisionId: ids.knowledgeRevisionId, roomName: `fixture-${ids.demoId}`, generation: 1, state: 'active', stateRevision: 1, reconnectAllowed: true, setupDeadlineAt: new Date(now + 20_000).toISOString(), startedAt: new Date(now).toISOString(), softCloseAt: new Date(now + 270_000).toISOString(), hardEndAt: new Date(now + 300_000).toISOString(), expiresAt };
  });
  metadata = { ...ids, workspaceToken, room: `fixture-${ids.demoId}`, token };
  return metadata;
}

await reset();
const handler = createApiHandler({ store, classifyTurn, preparationQueue: { healthy: () => true, start: async () => {}, stop: () => {} }, voiceAdapter: { end: async () => {} } });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/fixture/reset') { await reset(); response.end(JSON.stringify(metadata)); return; }
  if (url.pathname === '/fixture/state') { response.end(JSON.stringify(await store.read())); return; }
  if (url.pathname === '/fixture/browser-end') {
    request.url = `/v1/demos/${metadata.demoId}/end`; request.method = 'POST';
    request.headers = { ...request.headers, host: 'localhost', origin: 'http://localhost', 'x-frontline-csrf': 'fixture', cookie: `fl_workspace=${metadata.workspaceToken}; fl_csrf=fixture`, 'content-type': 'application/json' };
    await handler(request, response, new URL(request.url, 'http://localhost')); return;
  }
  await handler(request, response, url);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port.');
  process.stdout.write(`${JSON.stringify({ ...metadata, port: address.port })}\n`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
