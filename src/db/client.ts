import pg from "pg";
import { loadConfig } from "../config.js";

/** The Postgres pool. Sumbox is single-user and local-only: one role, one connection string. */
export function createDbClient() {
  const config = loadConfig();

  return new pg.Pool({
    connectionString: config.databaseUrl,
  });
}

/** Like createDbClient, but accepts an explicit connection string (used by tests). */
export function createAdminPool(connectionString?: string): pg.Pool {
  return new pg.Pool({ connectionString: connectionString ?? loadConfig().databaseUrl });
}
