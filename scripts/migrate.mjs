#!/usr/bin/env node
import { Client } from 'pg';
import { applyMigrations, inspectDatabase, loadManifest, verifyManifestFiles } from './lib/migration-runner.mjs';

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--dry-run'].includes(arg))) throw new Error('Usage: node scripts/migrate.mjs [--dry-run]');
const manifest = await loadManifest();
const entries = await verifyManifestFiles(manifest);
const dryRun = args.has('--dry-run');
if (!process.env.DATABASE_URL) {
  if (!dryRun) throw new Error('DATABASE_URL is required to apply migrations');
  console.log(JSON.stringify({mode:'dry-run-files-only', warning:'database_not_inspected', orderedMigrations: entries.map(({position,filename,sha256}) => ({position,filename,sha256}))}, null, 2));
  process.exit(0);
}
const client = new Client({connectionString: process.env.DATABASE_URL});
await client.connect();
try {
  if (dryRun) {
    await client.query('BEGIN READ ONLY');
    try {
      const state = await inspectDatabase(client, entries);
      console.log(JSON.stringify({mode:'dry-run-database', fresh:state.fresh, applied:state.applied.map((row) => row.filename), pending:state.pending.map((row) => row.filename)}, null, 2));
    } finally { await client.query('ROLLBACK'); }
  } else {
    const applied = await applyMigrations(client, manifest, entries);
    console.log(JSON.stringify({mode:'apply', applied:applied.map((entry) => entry.filename)}, null, 2));
  }
} finally { await client.end(); }
