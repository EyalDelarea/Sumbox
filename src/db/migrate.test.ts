import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyTestDatabase } from "../test/db.js";
import { runMigrationsDown, runMigrationsUp } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

describe("database migrations", () => {
  let connectionString: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    connectionString = await createEmptyTestDatabase();
    pool = new pg.Pool({ connectionString });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("runs all migrations UP and creates the four tables", async () => {
    await runMigrationsUp(connectionString, MIGRATIONS_DIR);

    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('groups', 'participants', 'imports', 'messages')
        ORDER BY table_name
      `);
      const tableNames = result.rows.map((r) => r.table_name).sort();
      expect(tableNames).toEqual(["groups", "imports", "messages", "participants"]);
    } finally {
      client.release();
    }
  }, 120_000);

  it("enforces dedupe_key uniqueness: ON CONFLICT DO NOTHING skips duplicate", async () => {
    const client = await pool.connect();
    try {
      // Insert a group
      const groupResult = await client.query<{ id: string }>(
        `INSERT INTO groups (name, source) VALUES ('Test Group', 'import') RETURNING id`,
      );
      const groupId = groupResult.rows[0].id;

      // Insert a participant
      const partResult = await client.query<{ id: string }>(
        `INSERT INTO participants (display_name) VALUES ('Alice') RETURNING id`,
      );
      const participantId = partResult.rows[0].id;

      const dedupeKey = "abc123deadbeef";
      const insertMsg = `
        INSERT INTO messages
          (group_id, participant_id, source, message_type, sent_at, dedupe_key)
        VALUES
          ($1, $2, 'import', 'text', now(), $3)
        ON CONFLICT (group_id, dedupe_key) DO NOTHING
      `;

      // First insert — should insert 1 row
      const first = await client.query(insertMsg, [groupId, participantId, dedupeKey]);
      expect(first.rowCount).toBe(1);

      // Second insert with same (group_id, dedupe_key) — should be skipped
      const second = await client.query(insertMsg, [groupId, participantId, dedupeKey]);
      expect(second.rowCount).toBe(0);

      // Confirm only one row exists
      const count = await client.query(
        `SELECT COUNT(*) AS cnt FROM messages WHERE group_id = $1 AND dedupe_key = $2`,
        [groupId, dedupeKey],
      );
      expect(Number(count.rows[0].cnt)).toBe(1);
    } finally {
      client.release();
    }
  }, 120_000);

  it("raises unique-violation on plain duplicate insert without ON CONFLICT", async () => {
    const client = await pool.connect();
    try {
      // Insert a fresh group
      const groupResult = await client.query<{ id: string }>(
        `INSERT INTO groups (name, source) VALUES ('Test Group Dupe', 'import') RETURNING id`,
      );
      const groupId = groupResult.rows[0].id;

      const partResult = await client.query<{ id: string }>(
        `INSERT INTO participants (display_name) VALUES ('Bob') RETURNING id`,
      );
      const participantId = partResult.rows[0].id;

      const dedupeKey = "dupekey9999";
      const insertMsg = `
        INSERT INTO messages
          (group_id, participant_id, source, message_type, sent_at, dedupe_key)
        VALUES
          ($1, $2, 'import', 'text', now(), $3)
      `;

      await client.query(insertMsg, [groupId, participantId, dedupeKey]);

      await expect(client.query(insertMsg, [groupId, participantId, dedupeKey])).rejects.toThrow(
        /unique/i,
      );
    } finally {
      client.release();
    }
  }, 120_000);

  it("runs all migrations DOWN cleanly", async () => {
    await runMigrationsDown(connectionString, MIGRATIONS_DIR);

    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('groups', 'participants', 'imports', 'messages')
      `);
      expect(result.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  }, 120_000);
});
