import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '../../server/api/postgres-store.js';
import { createMigratedDatabase } from './database.js';
import { asOwner, hash, hex64, seedClaimedOwner } from './fixtures.js';

// PO-C2 (PO-T10): which scope the existing store gives each request. Two claimed owners and one anonymous
// trial workspace share one database. Each probe reads what store.read() returns for a request and checks
// that nothing belongs to another owner.
let pg; let store; let ownerA; let ownerB; let trialToken;
const SECRET_A = 'PRIVATE-KNOWLEDGE-SENTINEL';

beforeEach(async () => {
  pg = await createMigratedDatabase();
  ownerA = await seedClaimedOwner(pg);
  ownerB = await seedClaimedOwner(pg);
  trialToken = hex64();
  const trialScope = randomUUID();
  await asOwner(pg, async () => {
    await pg.query("INSERT INTO ownership_scopes(id, kind, secret_hash, state, expires_at) VALUES ($1,'anonymous',$2,'anonymous', now() + interval '1 hour')", [trialScope, hash(trialToken)]);
    await pg.query('INSERT INTO scoped_workspace_states(owner_scope_id, state) VALUES ($1,$2::jsonb)', [trialScope, JSON.stringify({ workspaces: {}, agents: {}, knowledge: { trial: { facts: ['TRIAL-SENTINEL'] } }, demos: {} })]);
  });
  await pg.exec('SET ROLE frontline_app');
  store = Object.create(PostgresStore.prototype);
  store.ensureReady = async () => {};
  store.pool = { query: (sql, params) => pg.query(sql, params), connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) };
});

/** What a handler sees when it calls store.read() for this request. */
async function readFor(path, cookies) {
  const url = new URL(path, 'http://frontline.test');
  const request = { method: 'GET', headers: { host: url.host, cookie: cookies.join('; ') }, url: path };
  return JSON.stringify(await store.runForRequest(request, url, () => store.read()));
}
const asA = [`fl_auth=${'placeholder'}`];

describe('request scope resolution', () => {
  beforeEach(() => { asA[0] = `fl_auth=${ownerA.authToken}`; });

  it('gives an owner their own state on their own agent path, and nothing on another owner agent path', async () => {
    expect(await readFor(`/v1/agents/${ownerA.agentId}/history`, asA)).toContain(SECRET_A);
    const probe = await readFor(`/v1/agents/${ownerB.agentId}/history`, asA);
    expect(probe).not.toContain(SECRET_A);
    expect(probe).not.toContain(ownerB.agentId);
  });

  it.each([
    ['/v1/shared/session', 'guest'],
    ['/v1/shared/start', 'guest'],
    ['/v1/me/agents', 'signed-in home'],
    ['/v1/builder/feedback', 'builder'],
    ['/v1/builder/auth/start', 'builder'],
  ])('%s (%s) runs with no store scope even with an owner session and a trial cookie', async (path) => {
    const body = await readFor(path, [`fl_auth=${ownerA.authToken}`, `fl_workspace=${trialToken}`, `fl_guest=${hex64()}`]);
    expect(body).not.toContain(SECRET_A);
    expect(body).not.toContain('TRIAL-SENTINEL');
    expect(body).not.toContain(ownerA.agentId);
  });

  it('leaves the anonymous trial workspace path unchanged', async () => {
    expect(await readFor('/v1/preparations/abc', [`fl_workspace=${trialToken}`])).toContain('TRIAL-SENTINEL');
    expect(await readFor('/v1/sharedfoo', [`fl_workspace=${trialToken}`])).toContain('TRIAL-SENTINEL');
  });

  it('does not give an owner session the trial workspace, or a trial cookie an owner agent', async () => {
    expect(await readFor(`/v1/agents/${ownerA.agentId}/history`, [`fl_workspace=${trialToken}`])).not.toContain(SECRET_A);
    expect(await readFor(`/v1/agents/${ownerA.agentId}/history`, asA)).not.toContain('TRIAL-SENTINEL');
  });
});
