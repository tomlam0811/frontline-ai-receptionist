#!/usr/bin/env node
// Adds, lists or removes builder subjects. Run with the migration-owner connection only:
//   DATABASE_URL=... node scripts/builder/add-subject.mjs google:<sub> [--note "Tom"]
//   DATABASE_URL=... node scripts/builder/add-subject.mjs --list
//   DATABASE_URL=... node scripts/builder/add-subject.mjs --remove google:<sub>
// The subject is the provider subject stored with the Google sign-in ("google:" plus the
// Google `sub` claim). Removing a subject also stops its credentials (they are not honored
// once the subject is gone). An empty table denies every builder request.
//
// The table is empty when the migration is applied, and it stays empty until someone runs this
// script. Do not run it against a shared or production database until builder sign-in has passed
// the security review (gate G6). It is not run in CI or by any deploy step.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from 'pg';

const SUBJECT = /^google:[A-Za-z0-9._-]{3,128}$/;

/** Runs one command against any client with `query(text, params)`. Returns what to print. */
export async function applySubjectCommand(client, { subject, note, list, remove }) {
  if (list) {
    const { rows } = await client.query('SELECT provider_subject, added_at, note FROM frontline_builder_subjects ORDER BY added_at');
    return rows;
  }
  if (remove) {
    const result = await client.query('DELETE FROM frontline_builder_subjects WHERE provider_subject = $1', [remove]);
    return { removed: result.rowCount ?? result.affectedRows };
  }
  if (!SUBJECT.test(subject ?? '')) throw new Error('invalid_subject');
  const result = await client.query('INSERT INTO frontline_builder_subjects(provider_subject, note) VALUES ($1,$2) ON CONFLICT DO NOTHING', [subject, note ?? null]);
  return { added: result.rowCount ?? result.affectedRows };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { note: { type: 'string' }, list: { type: 'boolean' }, remove: { type: 'string' } } });
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL (migration owner) is required.'); process.exit(2); }
  const subject = positionals[0];
  if (!values.list && !values.remove && !SUBJECT.test(subject ?? '')) { console.error('Usage: add-subject.mjs google:<sub> [--note text] | --list | --remove google:<sub>'); process.exit(2); }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    console.log(JSON.stringify(await applySubjectCommand(client, { subject, ...values }), null, values.list ? 2 : 0));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
