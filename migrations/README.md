# Frontline migration application

`manifest.json` is the sole migration order. In particular, the colliding historical names are intentionally ordered exactly as:

1. `006_auth_claims.sql`
2. `006_exa_research_budget.sql`

The manifest records an immutable SHA-256 for every SQL file. Do not rename, edit, or infer ordering from a glob after publication; add a new migration and manifest entry instead.

## Safety model

Run with the migration-owner connection only. The coordinator provisions that owner and the separate `frontline_app` runtime role in the one existing Railway Postgres database. This tooling never creates a database, role, or credential.

```sh
node scripts/migrate.mjs --dry-run
node scripts/migrate.mjs
```

With `DATABASE_URL`, dry-run inspects the ledger in a read-only transaction and performs no mutation. Without it, dry-run verifies local checksums/order but clearly reports that the database was not inspected. Apply requires `DATABASE_URL`, obtains transaction-scoped advisory lock `46298131840`, validates the complete ledger as an exact ordered prefix, strips only each migration's outer `BEGIN`/`COMMIT`, and applies all pending SQL plus checksum ledger rows in one transaction.

A truly empty `public` schema receives a new ledger and all migrations. A database with a valid ledger resumes idempotently. A pre-existing schema without the ledger is ambiguous and fails closed: it is **not** auto-baselined. Unknown ledger rows, changed checksums, reordered/gapped history, SQL failure, or missing role prerequisites roll back. The coordinator must investigate and explicitly reconcile any pre-existing untracked schema before rerunning.
