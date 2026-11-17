import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase } from './database.js';
import { asOwner, bearer, browserClient, hash, seedClaimedOwner, seedSession, startServer } from './fixtures.js';
import { createHash, randomBytes } from 'node:crypto';

let pg; let app; let owner; let other; let builder; let ownerClient; let builderClient; let base;
const submit = (client, agentId, body, key) => client.request('POST', `/v1/agents/${agentId}/feedback`, { body, headers: key ? { 'idempotency-key': key } : {} });
const feedback = { category: 'quality', inputMethod: 'text', text: 'Blake talked over the caller when asked about hours.' };

beforeAll(async () => {
  pg = await createMigratedDatabase();
  owner = await seedClaimedOwner(pg);
  other = await seedClaimedOwner(pg);
  builder = await seedSession(pg, { builder: true });
  await pg.exec('SET ROLE frontline_app');
  app = startServer(pg);
  base = app.baseUrl;
  ownerClient = browserClient(app, owner.authToken);
  builderClient = browserClient(app, builder.authToken);
});
afterAll(async () => { await app?.close(); });

describe('owner feedback submission', () => {
  it('stores feedback, returns a receipt, and the builder can read it without owner internals', async () => {
    const response = await submit(ownerClient, owner.agentId, feedback, 'k-first');
    expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ category: 'quality', status: 'new' });
    const found = await (await builderClient.request('GET', `/v1/builder/feedback?q=talked+over`)).json();
    expect(found.records).toHaveLength(1);
    expect(found.records[0]).toMatchObject({ id: receipt.feedbackId, source: 'owner', inputMethod: 'text', agentId: owner.agentId, agentVersionId: owner.agentId, submittedText: feedback.text });
    expect(Object.keys(found.records[0])).not.toEqual(expect.arrayContaining(['ownerScopeId', 'creatorRef', 'idempotencyKey']));
    expect(JSON.stringify(found)).not.toContain(owner.scopeId);
  });

  it('is idempotent per key and rejects a reused key with different content', async () => {
    const first = await (await submit(ownerClient, owner.agentId, { ...feedback, text: 'idempotent one' }, 'k-idem')).json();
    const replay = await submit(ownerClient, owner.agentId, { ...feedback, text: 'idempotent one' }, 'k-idem');
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect((await replay.json()).feedbackId).toBe(first.feedbackId);
    const conflict = await submit(ownerClient, owner.agentId, { ...feedback, text: 'changed' }, 'k-idem');
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).title).toBe('idempotency_conflict');
    const count = await (await builderClient.request('GET', '/v1/builder/feedback?q=idempotent')).json();
    expect(count.records).toHaveLength(1);
  });

  it.each([
    [{ ...feedback, category: 'bug' }, 400, 'invalid_field'],
    [{ ...feedback, text: '   ' }, 400, 'invalid_field'],
    [{ ...feedback, text: 'x'.repeat(10001) }, 413, 'input_too_large'],
    [{ ...feedback, originalTranscript: 'raw' }, 400, 'invalid_field'],
    [{ ...feedback, inputMethod: 'voice' }, 400, 'invalid_field'],
    [{ ...feedback, agentVersionId: randomUUID() }, 400, 'invalid_field'],
    [{ ...feedback, conversationId: randomUUID() }, 422, 'conversation_not_found'],
  ])('rejects invalid input %#', async (body, status, code) => {
    const response = await submit(ownerClient, owner.agentId, body);
    expect(response.status).toBe(status);
    expect((await response.json()).title).toBe(code);
  });

  it('accepts a dictation with its original transcript and a 10,000 character text', async () => {
    const response = await submit(ownerClient, owner.agentId, { category: 'business_context', inputMethod: 'dictation', text: 'We close at 5.'.padEnd(10000, '.'), originalTranscript: 'we close at five' });
    expect(response.status).toBe(201);
    const stored = await (await builderClient.request('GET', `/v1/builder/feedback/${(await response.json()).feedbackId}`)).json();
    expect(stored.record).toMatchObject({ inputMethod: 'dictation', originalTranscript: 'we close at five', category: 'business_context' });
  });

  it('keeps owners apart and requires sign-in and CSRF', async () => {
    expect((await submit(ownerClient, other.agentId, feedback)).status).toBe(404);
    expect((await submit(browserClient(app, null), owner.agentId, feedback)).status).toBe(404);
    const noCsrf = await app.fetch(`${base}/v1/agents/${owner.agentId}/feedback`, { method: 'POST', headers: { origin: base, cookie: `fl_auth=${owner.authToken}`, 'content-type': 'application/json' }, body: JSON.stringify(feedback) });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await app.fetch(`${base}/v1/agents/${owner.agentId}/feedback`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: `fl_auth=${owner.authToken}; fl_csrf=a`, 'x-frontline-csrf': 'a', 'content-type': 'application/json' }, body: JSON.stringify(feedback) });
    expect(crossOrigin.status).toBe(403);
  });

  it('does not change the agent, its knowledge or any scope state (business feedback is not a knowledge edit)', async () => {
    const read = () => asOwner(pg, async () => (await pg.query('SELECT state, version FROM scoped_workspace_states WHERE owner_scope_id = $1', [owner.scopeId])).rows[0]);
    const before = await read();
    expect((await submit(ownerClient, owner.agentId, { category: 'business_context', inputMethod: 'text', text: 'We do not serve Tacoma.' })).status).toBe(201);
    expect(await read()).toEqual(before);
  });

  it('returns 503 feature_disabled when the flag is off', async () => {
    const off = startServer(pg, { enabled: false });
    const response = await submit(browserClient(off, owner.authToken), owner.agentId, feedback);
    expect(response.status).toBe(503);
    expect((await response.json()).title).toBe('feature_disabled');
    await off.close();
  });
});

describe('runtime role isolation', () => {
  it('cannot read or write the feedback and builder tables directly', async () => {
    for (const sql of ['SELECT * FROM frontline_feedback', 'SELECT * FROM frontline_builder_subjects', "INSERT INTO frontline_builder_subjects(provider_subject) VALUES ('google:x')", 'SELECT * FROM frontline_builder_credentials', 'SELECT * FROM frontline_builder_cli_codes']) {
      await expect(pg.query(sql)).rejects.toThrow(/permission denied/);
    }
    await expect(pg.query("SELECT builder_resolve_subject(NULL, 'x')")).rejects.toThrow(/permission denied/);
  });
});

describe('builder search', () => {
  it('denies everyone when there are no builder subjects and non-builder sessions', async () => {
    const stranger = await seedSession(pg);
    const response = await browserClient(app, stranger.authToken).request('GET', '/v1/builder/feedback');
    expect(response.status).toBe(403);
    expect((await response.json()).title).toBe('builder_forbidden');
    expect((await browserClient(app, null).request('GET', '/v1/builder/feedback')).status).toBe(401);
  });

  it('filters, and pages with a stable (created_at, id) cursor even when timestamps tie', async () => {
    const paging = await seedClaimedOwner(pg);
    const ids = [];
    await asOwner(pg, async () => { for (let i = 0; i < 7; i += 1) {
      const id = randomUUID(); ids.push(id);
      await pg.query(`INSERT INTO frontline_feedback(id, source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, created_at, expires_at)
        VALUES ($1,'owner','text',$2,$3,$4,$5,$5,'owner',$6,$7,$8,'2026-01-01T00:00:00.123456Z', now() + interval '10 days')`,
      [id, i % 2 ? 'functionality' : 'quality', `paging sentinel ${i}`, paging.scopeId, paging.agentId, hash(`c${i}`), `p${i}`, hash(`d${i}`)]);
    } });
    const seen = [];
    let cursor = null;
    do {
      const page = await (await builderClient.request('GET', `/v1/builder/feedback?q=sentinel&limit=3${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...page.records.map((record) => record.id));
      expect(page.records.length).toBeLessThanOrEqual(3);
      cursor = page.nextCursor;
    } while (cursor);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(7);
    const onlyFunctionality = await (await builderClient.request('GET', `/v1/builder/feedback?q=sentinel&category=functionality&agentId=${paging.agentId}`)).json();
    expect(onlyFunctionality.records).toHaveLength(3);
    const none = await (await builderClient.request('GET', '/v1/builder/feedback?q=zzzunmatchedzzz')).json();
    expect(none).toMatchObject({ schemaVersion: 1, records: [], nextCursor: null });
  });

  it('clamps the limit to 100 and rejects malformed filters', async () => {
    expect((await builderClient.request('GET', '/v1/builder/feedback?limit=1000')).status).toBe(400);
    for (const query of ['category=nope', 'source=robot', 'status=open', 'agentId=not-a-uuid', 'since=yesterday', 'cursor=@@@', 'limit=abc']) {
      const response = await builderClient.request('GET', `/v1/builder/feedback?${query}`);
      expect([response.status, (await response.json()).title]).toEqual([400, 'invalid_filter']);
    }
  });

  it('hides feedback past its retention date', async () => {
    const ownerRow = await seedClaimedOwner(pg);
    await asOwner(pg, () => pg.query(`INSERT INTO frontline_feedback(source, input_method, category, submitted_text, owner_scope_id, stable_agent_id, agent_version_id, creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
      VALUES ('owner','text','other','expiredsentinel',$1,$2,$2,'owner',$3,'e1',$4, now() - interval '1 second')`, [ownerRow.scopeId, ownerRow.agentId, hash('c'), hash('d')]));
    expect((await (await builderClient.request('GET', '/v1/builder/feedback?q=expiredsentinel')).json()).records).toHaveLength(0);
  });
});

describe('builder status changes', () => {
  it('follows the transition table, checks the revision and records events', async () => {
    const { feedbackId } = await (await submit(ownerClient, owner.agentId, { ...feedback, text: 'status flow sentinel' })).json();
    const patch = (status, expectedRevision) => builderClient.request('PATCH', `/v1/builder/feedback/${feedbackId}`, { body: { status, expectedRevision } });
    const reviewed = await patch('reviewed', 1);
    expect(reviewed.status).toBe(200);
    expect((await reviewed.json()).record).toMatchObject({ status: 'reviewed', revision: 2 });
    expect((await patch('resolved', 1)).status).toBe(409);
    expect((await patch('reviewed', 2)).status).toBe(422);
    expect((await patch('resolved', 2)).status).toBe(200);
    const record = (await (await builderClient.request('GET', `/v1/builder/feedback/${feedbackId}`)).json()).record;
    expect(record.events.map((event) => [event.action, event.toStatus])).toEqual([['submitted', 'new'], ['status_changed', 'reviewed'], ['status_changed', 'resolved']]);
    expect((await patch('other', 3)).status).toBe(400);
    expect((await browserClient(app, owner.authToken).request('PATCH', `/v1/builder/feedback/${feedbackId}`, { body: { status: 'new', expectedRevision: 3 } })).status).toBe(403);
  });
});

describe('builder CLI credential', () => {
  const pkce = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
  const approve = async (challenge) => (await (await builderClient.request('POST', '/v1/builder/credentials', { body: { challenge, label: 'laptop' } })).json()).code;
  const exchange = (code, verifier) => app.fetch(`${base}/v1/builder/credentials/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier }) });

  it('issues a read-only flb_ token through PKCE, once, and the token can read but not change status', async () => {
    const { verifier, challenge } = pkce();
    const code = await approve(challenge);
    const issued = await exchange(code, verifier);
    expect(issued.status).toBe(201);
    const { token, expiresAt, scope } = await issued.json();
    expect(token).toMatch(/^flb_[A-Za-z0-9_-]{43}$/);
    expect(scope).toBe('feedback:read');
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThan(7.1);
    const read = bearer(app, token);
    expect((await read('GET', '/v1/builder/feedback?limit=1')).status).toBe(200);
    const target = (await (await read('GET', '/v1/builder/feedback?limit=1')).json()).records[0];
    const patched = await read('PATCH', `/v1/builder/feedback/${target.id}`, { status: 'reviewed', expectedRevision: target.revision });
    expect(patched.status).toBe(403);
    expect((await patched.json()).title).toBe('credential_read_only');
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  it('rejects a wrong verifier and burns the code', async () => {
    const { verifier, challenge } = pkce();
    const code = await approve(challenge);
    expect((await exchange(code, pkce().verifier)).status).toBe(401);
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  it('rejects an expired code, a non-builder approval, and a malformed challenge', async () => {
    const { verifier, challenge } = pkce();
    const code = await approve(challenge);
    await asOwner(pg, () => pg.query("UPDATE frontline_builder_cli_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [hash(code)]));
    expect((await exchange(code, verifier)).status).toBe(401);
    const stranger = await seedSession(pg);
    expect((await browserClient(app, stranger.authToken).request('POST', '/v1/builder/credentials', { body: { challenge } })).status).toBe(403);
    expect((await builderClient.request('POST', '/v1/builder/credentials', { body: { challenge: 'short' } })).status).toBe(400);
  });

  it('rejects expired, revoked and removed-subject credentials, and logout revokes', async () => {
    const make = async () => { const { verifier, challenge } = pkce(); return (await (await exchange(await approve(challenge), verifier)).json()); };
    const expired = await make();
    await asOwner(pg, () => pg.query("UPDATE frontline_builder_credentials SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hash(expired.token)]));
    expect((await bearer(app, expired.token)('GET', '/v1/builder/feedback')).status).toBe(401);

    const revoked = await make();
    expect((await builderClient.request('DELETE', `/v1/builder/credentials/${revoked.credentialId}`)).status).toBe(200);
    expect((await bearer(app, revoked.token)('GET', '/v1/builder/feedback')).status).toBe(401);

    const loggedOut = await make();
    expect((await bearer(app, loggedOut.token)('DELETE', '/v1/builder/credentials/current')).status).toBe(200);
    expect((await bearer(app, loggedOut.token)('GET', '/v1/builder/feedback')).status).toBe(401);

    const removedSubject = await seedSession(pg, { builder: true });
    const client = browserClient(app, removedSubject.authToken);
    const { verifier, challenge } = pkce();
    const code = (await (await client.request('POST', '/v1/builder/credentials', { body: { challenge } })).json()).code;
    const token = (await (await exchange(code, verifier)).json()).token;
    expect((await bearer(app, token)('GET', '/v1/builder/feedback?limit=1')).status).toBe(200);
    await asOwner(pg, () => pg.query('DELETE FROM frontline_builder_subjects WHERE provider_subject = $1', [removedSubject.subject]));
    expect((await asOwner(pg, () => pg.query('SELECT count(*)::int AS n FROM frontline_builder_credentials WHERE provider_subject = $1', [removedSubject.subject]))).rows[0].n).toBe(0);
    expect((await bearer(app, token)('GET', '/v1/builder/feedback')).status).toBe(401);
    expect((await bearer(app, 'flb_short')('GET', '/v1/builder/feedback')).status).toBe(401);
  });
});
