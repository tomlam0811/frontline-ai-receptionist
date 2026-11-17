import { beforeEach, describe, expect, it } from 'vitest';
import { applySubjectCommand } from '../../scripts/builder/add-subject.mjs';
import { createMigratedDatabase } from './database.js';
import { asOwner, browserClient, seedSession, startServer } from './fixtures.js';

// PO-C12: the builder allowlist script, on the real migrations. It runs as the migration owner, so the script's own
// statements run with the owner role. The rest is the real handler: an empty allowlist denies every builder request.
let pg;
beforeEach(async () => { pg = await createMigratedDatabase(); });
const run = (command) => asOwner(pg, () => applySubjectCommand(pg, command));
const subjectCount = () => asOwner(pg, async () => Number((await pg.query('SELECT count(*) AS n FROM frontline_builder_subjects')).rows[0].n));

describe('the builder allowlist script', () => {
  it('starts empty: a fresh database has no builder subject', async () => {
    expect(await subjectCount()).toBe(0);
  });

  it('adds one subject once, lists it, and removes it', async () => {
    expect(await run({ subject: 'google:abc123', note: 'Tom' })).toEqual({ added: 1 });
    expect(await run({ subject: 'google:abc123', note: 'again' })).toEqual({ added: 0 });
    const listed = await run({ list: true });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ provider_subject: 'google:abc123', note: 'Tom' });
    expect(await run({ remove: 'google:abc123' })).toEqual({ removed: 1 });
    expect(await subjectCount()).toBe(0);
  });

  it('refuses a subject that is not a Google subject', async () => {
    for (const bad of ['abc123', 'google:', 'github:abc', "google:a'; DROP TABLE x;--"]) {
      await expect(run({ subject: bad })).rejects.toThrow('invalid_subject');
    }
    expect(await subjectCount()).toBe(0);
  });
});

describe('builder requests against the allowlist', () => {
  it('denies every builder request while the table is empty, and admits a listed subject only', async () => {
    const person = await seedSession(pg, { subject: 'google:abc123' });
    await pg.exec('SET ROLE frontline_app');
    const app = startServer(pg);
    const client = browserClient(app, person.authToken);
    const denied = await client.request('GET', '/v1/builder/feedback');
    expect(denied.status).toBe(403);
    expect((await denied.json()).title).toBe('builder_forbidden');
    expect((await (await client.request('GET', '/v1/builder/session')).json()).builder).toBe(false);

    await run({ subject: 'google:abc123', note: 'test' });
    await pg.exec('SET ROLE frontline_app');
    expect((await client.request('GET', '/v1/builder/feedback')).status).toBe(200);
    expect((await (await client.request('GET', '/v1/builder/session')).json()).builder).toBe(true);

    await run({ remove: 'google:abc123' });
    await pg.exec('SET ROLE frontline_app');
    expect((await client.request('GET', '/v1/builder/feedback')).status).toBe(403);
  });
});
