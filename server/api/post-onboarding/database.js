// The post-onboarding modules talk to Postgres through this minimal interface:
//   query(text, params) -> { rows }
//   transaction(fn)     -> runs fn(tx) in one transaction; tx has query()
// `fromPool` adapts a node-postgres Pool (production and local dev). `fromPglite`
// adapts an in-process Postgres and is used by the automated tests.
export function fromPool(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* the original error is the useful one */ }
        throw error;
      } finally { client.release(); }
    },
  };
}

export function fromPglite(db) {
  const wrap = (target) => ({ query: async (text, params) => { const result = await target.query(text, params); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; } });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx))) };
}

// Runs fn inside a transaction with the transaction-local owner scope set, the
// same setting the existing store uses for forced row level security.
export function inOwnerScope(db, scopeId, fn) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.owner_scope_id', $1, true)", [scopeId]);
    return fn(tx);
  });
}
