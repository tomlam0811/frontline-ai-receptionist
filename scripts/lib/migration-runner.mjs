import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const manifestPath = path.join(root, 'migrations/manifest.json');
export const ledgerTable = 'frontline_schema_migrations';

export async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.migrations) || manifest.migrations.some((entry, index) => entry.position !== index + 1 || !/^\d{3}_[a-z0-9_]+\.sql$/.test(entry.filename) || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error('invalid_migration_manifest');
  if (new Set(manifest.migrations.map(({filename}) => filename)).size !== manifest.migrations.length) throw new Error('duplicate_migration_filename');
  return manifest;
}

export async function verifyManifestFiles(manifest) {
  const loaded = [];
  for (const entry of manifest.migrations) {
    const sql = await readFile(path.join(root, 'migrations', entry.filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (checksum !== entry.sha256) throw new Error(`migration_checksum_mismatch:${entry.filename}`);
    loaded.push({...entry, sql});
  }
  return loaded;
}

export function planMigrations(entries, ledgerRows) {
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));
  const applied = new Map();
  for (const row of ledgerRows) {
    const expected = byName.get(row.filename);
    if (!expected) throw new Error(`unknown_applied_migration:${row.filename}`);
    if (expected.position !== Number(row.position) || expected.sha256 !== row.sha256) throw new Error(`applied_migration_mismatch:${row.filename}`);
    applied.set(row.filename, row);
  }
  for (let index = 0; index < ledgerRows.length; index += 1) {
    if (ledgerRows[index].filename !== entries[index]?.filename) throw new Error('migration_ledger_is_not_an_ordered_prefix');
  }
  return entries.filter((entry) => !applied.has(entry.filename));
}

export function withoutOuterTransaction(sql) {
  const normalized = sql.replace(/^\uFEFF?\s*BEGIN\s*;\s*/i, '').replace(/\s*COMMIT\s*;\s*$/i, '\n');
  if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(normalized) || /\bCOMMIT\s*;\s*$/i.test(normalized)) throw new Error('unsupported_nested_transaction');
  return normalized;
}

async function publicTables(client) {
  const {rows} = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename <> $1 ORDER BY tablename", [ledgerTable]);
  return rows.map((row) => row.tablename);
}

export async function inspectDatabase(client, entries) {
  const exists = await client.query('SELECT to_regclass($1) AS ledger', [`public.${ledgerTable}`]);
  if (!exists.rows[0].ledger) {
    const tables = await publicTables(client);
    if (tables.length) throw new Error(`ambiguous_untracked_schema:${tables.join(',')}`);
    return {fresh: true, pending: entries, applied: []};
  }
  const {rows} = await client.query(`SELECT position, filename, sha256 FROM ${ledgerTable} ORDER BY position`);
  return {fresh: false, pending: planMigrations(entries, rows), applied: rows};
}

export async function applyMigrations(client, manifest, entries) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [manifest.advisoryLockId]);
    const state = await inspectDatabase(client, entries);
    if (state.fresh) await client.query(`CREATE TABLE ${ledgerTable} (position integer PRIMARY KEY, filename text UNIQUE NOT NULL, sha256 text NOT NULL CHECK (length(sha256) = 64), applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const entry of state.pending) {
      await client.query(withoutOuterTransaction(entry.sql));
      await client.query(`INSERT INTO ${ledgerTable}(position, filename, sha256) VALUES ($1,$2,$3)`, [entry.position, entry.filename, entry.sha256]);
    }
    await client.query('COMMIT');
    return state.pending;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
