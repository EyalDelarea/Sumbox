import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { loadConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

/**
 * Run all pending migrations UP.
 * @param databaseUrl  Postgres connection string (defaults to DATABASE_URL from env)
 * @param migrationsDir  Absolute path to migration files directory
 */
export async function runMigrationsUp(
  databaseUrl?: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  count: number = Infinity,
): Promise<void> {
  const url = databaseUrl ?? loadConfig().databaseUrl;
  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    // Number of pending migrations to apply (default: all). A finite count is used
    // by tests to stop before a given migration (e.g. seed pre-tenancy data, then
    // run the tenancy migrations to verify zero-loss backfill).
    count,
    // Suppress noisy console output
    log: () => {},
  });
}

/**
 * Run all applied migrations DOWN (roll back in reverse order).
 * @param databaseUrl  Postgres connection string (defaults to DATABASE_URL from env)
 * @param migrationsDir  Absolute path to migration files directory
 */
export async function runMigrationsDown(
  databaseUrl?: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  const url = databaseUrl ?? loadConfig().databaseUrl;
  // Roll back one at a time until none remain
  let migrated: Awaited<ReturnType<typeof runner>>;
  do {
    migrated = await runner({
      databaseUrl: url,
      dir: migrationsDir,
      direction: "down",
      migrationsTable: "pgmigrations",
      count: 1,
      log: () => {},
    });
  } while (migrated.length > 0);
}

// When executed directly as a CLI script: run migrations UP
const isMain =
  process.argv[1] != null &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith("/migrate.js") ||
    process.argv[1].endsWith("/migrate.ts"));

if (isMain) {
  const direction = process.argv[2] === "down" ? "down" : "up";
  const fn = direction === "down" ? runMigrationsDown : runMigrationsUp;
  fn()
    .then(() => {
      console.log(`Migrations ${direction} completed.`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
