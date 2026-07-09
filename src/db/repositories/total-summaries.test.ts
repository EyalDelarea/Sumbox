import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { insertTotalSummary, listTotalSummaries } from "./total-summaries.js";

describe("total-summaries repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("inserts a total summary and reads it back newest-first", async () => {
    const output = {
      highlights: "🔔 דורש תשומת לב\n- [Work] לאשר תקציב",
      perChat: [{ groupId: 1, name: "Work", messageCount: 12, summary: "## תקציר\nעבודה" }],
    };
    const id = await insertTotalSummary(pool, {
      rangeKind: "since",
      parameters: { since: "2026-06-06T00:00:00.000Z" },
      output,
      model: "gemma4:26b",
    });
    expect(id).toBeGreaterThan(0);

    const rows = await listTotalSummaries(pool, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]!.rangeKind).toBe("since");
    expect(rows[0]!.output.highlights).toContain("דורש תשומת לב");
    expect(rows[0]!.output.perChat[0]!.name).toBe("Work");
  });
});
