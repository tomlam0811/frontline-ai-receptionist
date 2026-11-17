import { PGlite } from '@electric-sql/pglite';
import { loadManifest, verifyManifestFiles, withoutOuterTransaction } from '../../scripts/lib/migration-runner.mjs';

// Real Postgres (in-process) with the real migrations applied in manifest order.
// Nothing here is a mock: SQL functions, RLS and role grants run as in production.
/** @param {{through?: number}} [options] */
export async function createMigratedDatabase({ through } = {}) {
  const db = new PGlite();
  await db.exec('CREATE ROLE frontline_app NOLOGIN; CREATE ROLE frontline_cleanup NOLOGIN;');
  const entries = await verifyManifestFiles(await loadManifest());
  for (const entry of entries) {
    if (through && entry.position > through) break;
    await db.exec(withoutOuterTransaction(entry.sql));
  }
  return db;
}

// Runs fn as the runtime role, as the API does, then restores the owner role.
export async function asRuntime(db, fn) {
  await db.exec('SET ROLE frontline_app');
  try { return await fn(db); } finally { await db.exec('RESET ROLE'); }
}

export async function asCleanup(db, fn) {
  await db.exec('SET ROLE frontline_cleanup');
  try { return await fn(db); } finally { await db.exec('RESET ROLE'); }
}
