import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import {
  listCommandPermissions,
  SUMMARY_COMMAND_KEY,
  upsertCommandPermission,
} from "./group-command-permissions.js";
import { upsertGroup } from "./groups.js";

describe("group-command-permissions repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("keys permissions on the stable 'summary' identifier, not the trigger text", async () => {
    const groupId = await upsertGroup(pool, { name: "כדורגל", source: "import" });
    await upsertCommandPermission(pool, { groupId, enabled: true });
    const rows = await listCommandPermissions(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.command).toBe(SUMMARY_COMMAND_KEY);
    expect(rows[0]!.command).toBe("summary");
  });

  it("defaults command to 'summary' when omitted in raw insert", async () => {
    const groupId = await upsertGroup(pool, { name: "כדורגל ברדיאו", source: "import" });
    // Insert via raw SQL, omitting the command column to test the DB default
    await pool.query(`INSERT INTO group_command_permissions (group_id, enabled) VALUES ($1, $2)`, [
      groupId,
      true,
    ]);
    const { rows } = await pool.query<{ command: string }>(
      `SELECT command FROM group_command_permissions WHERE group_id = $1`,
      [groupId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.command).toBe("summary");
  });
});
