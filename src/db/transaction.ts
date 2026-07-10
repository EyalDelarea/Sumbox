import type pg from "pg";

/**
 * Run a unit of work in one transaction on a single pooled connection: BEGIN, run
 * `fn` with that client, COMMIT — or ROLLBACK and rethrow on error.
 *
 * Callers that need several statements to land atomically (or to hold row locks
 * across them) must go through here; a bare pool autocommits each query
 * independently, which is fine for single statements and wrong for the rest.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
