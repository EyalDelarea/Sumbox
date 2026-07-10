import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { inject } from "vitest";
import type { GlobalSetupContext } from "vitest/node";
import { DEFAULT_MIGRATIONS_DIR, runMigrationsUp } from "../db/migrate.js";

// Shared Postgres for the whole test suite. Instead of every test file booting its
// own container and re-running all migrations, we boot ONE container, migrate a
// template database once, and hand each test file an isolated clone of it via
// `CREATE DATABASE ... TEMPLATE` (a near-instant copy). This removes ~45 redundant
// container boots + migration runs and lets test files run fully in parallel.

const TEMPLATE_DB = "template_sumbox";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUri: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Vitest globalSetup: boot one Postgres and migrate the template database once.
 * The admin connection URI is provided to test workers via `inject("pgAdminUri")`.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  // max_connections is raised because many parallel test files each open a pool
  // against this single server.
  // pgvector image (not the stock postgres) so `CREATE EXTENSION vector` in the
  // message_embeddings migration succeeds. pg16 matches the docker-compose major.
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withCommand(["postgres", "-c", "max_connections=300"])
    .start();
  const adminUri = container.getConnectionUri();

  // Create the template and migrate it once. Nothing connects to the template
  // during the run, so `CREATE DATABASE ... TEMPLATE` clones stay valid.
  const admin = new pg.Client({ connectionString: adminUri });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  await runMigrationsUp(uriWithDatabase(adminUri, TEMPLATE_DB), DEFAULT_MIGRATIONS_DIR);

  provide("pgAdminUri", adminUri);

  return async () => {
    await container?.stop();
  };
}

function uriWithDatabase(uri: string, database: string): string {
  const u = new URL(uri);
  u.pathname = `/${database}`;
  return u.toString();
}

async function createDatabase(template: string | null): Promise<string> {
  const adminUri = inject("pgAdminUri");
  const name = `test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: adminUri });
  await admin.connect();
  try {
    await admin.query(
      template ? `CREATE DATABASE "${name}" TEMPLATE ${template}` : `CREATE DATABASE "${name}"`,
    );
  } finally {
    await admin.end();
  }
  return uriWithDatabase(adminUri, name);
}

/**
 * A fresh, already-migrated database (cloned from the template). Call in `beforeAll`
 * and pass the returned connection string to a `pg.Pool` / the app under test.
 */
export function createTestDatabase(): Promise<string> {
  return createDatabase(TEMPLATE_DB);
}

/**
 * A fresh, EMPTY database (no migrations applied) — for tests that exercise the
 * migration runner itself.
 */
export function createEmptyTestDatabase(): Promise<string> {
  return createDatabase(null);
}
