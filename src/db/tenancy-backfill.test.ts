import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyTestDatabase } from "../test/db.js";
import { runMigrationsUp } from "./migrate.js";

/**
 * US2 — zero data loss on upgrade (SC-003). Seed a database with the PRE-tenancy
 * schema, then run the tenancy migrations (021–025) and assert every row is preserved
 * and attributed to the default tenant.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

// Number of migrations that predate tenancy (1748649600000 .. 1748649600020_create_message_media).
const PRE_TENANCY_COUNT = 21;
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const SCOPED_TABLES = [
  "groups",
  "participants",
  "imports",
  "messages",
  "transcripts",
  "summaries",
  "total_summaries",
  "media_analyses",
  "message_media",
  "read_watermarks",
  "job_runs",
  "scheduler_state",
];

let uri: string;
let pool: pg.Pool;
const before: Record<string, number> = {};

beforeAll(async () => {
  uri = await createEmptyTestDatabase();
  pool = new pg.Pool({ connectionString: uri });

  // 1. Migrate ONLY the pre-tenancy schema.
  await runMigrationsUp(uri, MIGRATIONS_DIR, PRE_TENANCY_COUNT);

  // 2. Seed representative rows across several scoped tables (old schema, no tenant_id).
  const { rows: g } = await pool.query<{ id: string }>(
    `INSERT INTO groups (whatsapp_id, name, source) VALUES ('jid@g.us', 'Legacy Group', 'live') RETURNING id`,
  );
  const groupId = Number(g[0].id);
  const { rows: p } = await pool.query<{ id: string }>(
    `INSERT INTO participants (display_name) VALUES ('Legacy Person') RETURNING id`,
  );
  const participantId = Number(p[0].id);
  const { rows: m } = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, participant_id, source, message_type, sent_at, dedupe_key)
     VALUES ($1, $2, 'live', 'text', now(), 'dk-legacy-1') RETURNING id`,
    [groupId, participantId],
  );
  const messageId = Number(m[0].id);
  await pool.query(
    `INSERT INTO transcripts (message_id, status, engine, transcript) VALUES ($1, 'completed', 'whisper', 'hi')`,
    [messageId],
  );
  await pool.query(
    `INSERT INTO message_media (message_id, media_kind, download_state) VALUES ($1, 'image', 'pending')`,
    [messageId],
  );
  await pool.query(
    `INSERT INTO summaries (group_id, summary_type, parameters, output, model)
     VALUES ($1, 'last_n', '{}'::jsonb, '{}'::jsonb, 'gemma')`,
    [groupId],
  );
  await pool.query(`INSERT INTO scheduler_state (slot_key, last_run_at) VALUES ('08:00', now())`);

  // 3. Capture row counts BEFORE tenancy migration.
  for (const t of SCOPED_TABLES) {
    const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::int AS c FROM ${t}`);
    before[t] = Number(rows[0].c);
  }

  // 4. Run the remaining (tenancy) migrations.
  await runMigrationsUp(uri, MIGRATIONS_DIR);
});

afterAll(async () => {
  await pool?.end();
});

describe("zero-loss backfill (SC-003)", () => {
  it.each(SCOPED_TABLES)("%s keeps the same row count after upgrade", async (table) => {
    const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::int AS c FROM ${table}`);
    expect(Number(rows[0].c)).toBe(before[table]);
  });

  it.each(
    SCOPED_TABLES,
  )("%s attributes every existing row to the default tenant", async (table) => {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::int AS c FROM ${table} WHERE tenant_id <> $1`,
      [DEFAULT_TENANT_ID],
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("preserves seeded content (no rows lost)", async () => {
    const { rows } = await pool.query(`SELECT name FROM groups WHERE name = 'Legacy Group'`);
    expect(rows).toHaveLength(1);
  });
});
