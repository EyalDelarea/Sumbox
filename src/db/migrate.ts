import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { loadConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

/**
 * Apply migrations in timestamp order WITHOUT requiring that they arrived in it.
 *
 * Timestamp order is CREATION order, not merge order — and this repo creates
 * migrations with `migrate:create` on parallel branches precisely so numbers
 * can't collide. Two branches therefore routinely land newest-first: #52's
 * `sender_jid` merged before #48's `content_hash`, which had been written days
 * earlier. Under node-pg-migrate's default `checkOrder`, the straggler then
 * "precedes an already run migration" and EVERY subsequent `make dev` aborts on
 * a dev DB that is otherwise perfectly healthy — the failure is permanent and
 * needs a manual `pgmigrations` edit to clear.
 *
 * Safe because each migration is one self-contained concern (CLAUDE.md): the two
 * above touch different tables entirely, so applying a straggler after a newer
 * sibling is a no-op difference. Ordering still holds where it actually matters —
 * a fresh database (CI, tests, a new machine) applies everything in ascending
 * order from empty. And this does not excuse a duplicate NUMBER: migrations.test.ts
 * still fails CI on that, which is the collision that genuinely corrupts order.
 */
const CHECK_ORDER = false;

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
    checkOrder: CHECK_ORDER,
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
      checkOrder: CHECK_ORDER,
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
