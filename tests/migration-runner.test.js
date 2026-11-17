import { describe, expect, it } from 'vitest';
import { inspectDatabase, loadManifest, planMigrations, verifyManifestFiles, withoutOuterTransaction } from '../scripts/lib/migration-runner.mjs';

describe('migration manifest', () => {
  it('verifies checksums and exact dual-006 order', async () => {
    const manifest = await loadManifest(); const entries = await verifyManifestFiles(manifest);
    expect(entries.slice(5, 7).map((entry) => entry.filename)).toEqual(['006_auth_claims.sql','006_exa_research_budget.sql']);
    expect(entries.map((entry) => entry.position)).toEqual(entries.map((_, index) => index + 1));
    expect(planMigrations(entries, [])).toHaveLength(entries.length);
  });
  it('is idempotent for a complete exact ledger', async () => {
    const entries = await verifyManifestFiles(await loadManifest());
    expect(planMigrations(entries, entries.map(({position,filename,sha256}) => ({position,filename,sha256})))).toEqual([]);
  });
  it('fails closed for unknown, changed, or non-prefix ledger history', async () => {
    const entries = await verifyManifestFiles(await loadManifest());
    expect(() => planMigrations(entries,[{position:1,filename:'999_unknown.sql',sha256:'a'.repeat(64)}])).toThrow('unknown_applied_migration');
    expect(() => planMigrations(entries,[{...entries[0],sha256:'a'.repeat(64)}])).toThrow('applied_migration_mismatch');
    expect(() => planMigrations(entries,[entries[1]])).toThrow('migration_ledger_is_not_an_ordered_prefix');
  });
  it('recognizes a fresh empty database but fails closed on an untracked schema', async () => {
    const entries = await verifyManifestFiles(await loadManifest());
    const empty = {query: async (sql) => sql.startsWith('SELECT to_regclass') ? {rows:[{ledger:null}]} : {rows:[]}};
    await expect(inspectDatabase(empty,entries)).resolves.toMatchObject({fresh:true,pending:entries});
    const ambiguous = {query: async (sql) => sql.startsWith('SELECT to_regclass') ? {rows:[{ledger:null}]} : {rows:[{tablename:'ownership_scopes'}]}};
    await expect(inspectDatabase(ambiguous,entries)).rejects.toThrow('ambiguous_untracked_schema');
  });
  it('inspects a pre-existing exact ledger without mutation', async () => {
    const entries = await verifyManifestFiles(await loadManifest());
    const rows = entries.slice(0,2).map(({position,filename,sha256}) => ({position,filename,sha256}));
    const existing = {query: async (sql) => sql.startsWith('SELECT to_regclass') ? {rows:[{ledger:'frontline_schema_migrations'}]} : {rows}};
    await expect(inspectDatabase(existing,entries)).resolves.toMatchObject({fresh:false,applied:rows,pending:entries.slice(2)});
  });
  it('removes only outer transaction wrappers', () => {
    expect(withoutOuterTransaction('BEGIN;\nSELECT 1;\nCOMMIT;')).toBe('SELECT 1;\n');
    expect(withoutOuterTransaction('SELECT 1;')).toBe('SELECT 1;');
  });
});
