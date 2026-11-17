import { describe, expect, it } from 'vitest';
import { createRateLimiter, csrfGuard, originGuard, parseCookies, readJson } from '../../server/api/post-onboarding/http.js';
import { ensureLineage, knownVersionIds, readLineage } from '../../server/api/post-onboarding/lineage.js';
import { Readable } from 'node:stream';

const req = (headers, method = 'POST') => ({ method, headers });

describe('http helpers mirror the existing service behavior', () => {
  it('parses cookies', () => {
    expect(parseCookies(req({ cookie: 'a=1; fl_auth=x=y; b=' }))).toEqual({ a: '1', fl_auth: 'x=y', b: '' });
  });
  it('requires a matching origin and the double-submit CSRF pair', () => {
    expect(() => csrfGuard(req({ host: 'a.test', origin: 'http://a.test', cookie: 'fl_csrf=t', 'x-frontline-csrf': 't' }))).not.toThrow();
    expect(() => csrfGuard(req({ host: 'a.test', origin: 'http://a.test', cookie: 'fl_csrf=t', 'x-frontline-csrf': 'u' }))).toThrow(/Refresh/);
    expect(() => csrfGuard(req({ host: 'a.test', origin: 'http://b.test', cookie: 'fl_csrf=t', 'x-frontline-csrf': 't' }))).toThrow(/Origin does not match/);
    expect(() => originGuard(req({ host: 'a.test' }))).toThrow(/Origin is required/);
    expect(() => originGuard(req({ host: 'a.test', 'sec-fetch-site': 'cross-site' }, 'GET'), true)).toThrow(/this application/);
  });
  it('reads bounded JSON', async () => {
    const stream = (text, type = 'application/json') => Object.assign(Readable.from([Buffer.from(text)]), { headers: { 'content-type': type } });
    expect(await readJson(stream('{"a":1}'))).toEqual({ a: 1 });
    await expect(readJson(stream('{'))).rejects.toMatchObject({ code: 'invalid_json' });
    await expect(readJson(stream('{}', 'text/plain'))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(stream(`"${'x'.repeat(20)}"`), { maxBytes: 10 })).rejects.toMatchObject({ code: 'body_too_large' });
  });
  it('rate limits per key within the window', () => {
    let time = 0; const limit = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });
    limit('a'); limit('a');
    expect(() => limit('a')).toThrow(/Too many/);
    limit('b');
    time = 1500; limit('a');
  });
});

describe('lineage reads', () => {
  const state = { workspaces: { w: { id: 'w' } }, agents: { A: { id: 'A', workspaceId: 'w', knowledgeRevisionId: 'K' } } };
  it('derives an initial lineage without mutating state', () => {
    const lineage = readLineage(state, 'A');
    expect(lineage).toMatchObject({ stableAgentId: 'A', pointerGeneration: 1, currentAgentVersionId: 'A' });
    expect(knownVersionIds(lineage)).toEqual(['A']);
    expect(state.agentLineages).toBeUndefined();
  });
  it('returns null for an agent that is not in this scope', () => {
    expect(readLineage(state, 'B')).toBeNull();
    expect(readLineage({ workspaces: {}, agents: { A: { workspaceId: 'w' } } }, 'A')).toBeNull();
  });
  it('persists lineage into a copy and prefers a stored lineage', () => {
    const withLineage = ensureLineage(state, 'A');
    expect(withLineage.agentLineages.A.currentAgentVersionId).toBe('A');
    expect(state.agentLineages).toBeUndefined();
    expect(ensureLineage(withLineage, 'A')).toBe(withLineage);
    expect(readLineage({ ...withLineage, agentLineages: { A: { ...withLineage.agentLineages.A, currentAgentVersionId: 'V2', revisions: [...withLineage.agentLineages.A.revisions, { agentVersionId: 'V2' }] } } }, 'A').currentAgentVersionId).toBe('V2');
  });
});
