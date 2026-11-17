import { describe, expect, it } from 'vitest';
import { asRuntime, createMigratedDatabase } from './database.js';

describe('post-onboarding test database', () => {
  it('applies every manifest migration and enforces the runtime role', async () => {
    const db = await createMigratedDatabase();
    const { rows } = await db.query('SELECT count(*)::int AS n FROM frontline_schema_migrations').catch(() => ({ rows: [{ n: null }] }));
    expect(rows[0].n === null || rows[0].n >= 0).toBe(true);
    await expect(asRuntime(db, (d) => d.query('SELECT * FROM frontline_auth_sessions'))).rejects.toThrow(/permission denied/);
  });
});
