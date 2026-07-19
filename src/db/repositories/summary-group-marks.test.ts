import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import { insertSummary } from "./summaries.js";
import { getSummaryGroupMark, upsertSummaryGroupMark } from "./summary-group-marks.js";

describe("summary_group_marks", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("upserts + reads the group mark, and updates on conflict", async () => {
    const groupId = await upsertGroup(pool, { name: "GM-1", source: "import" });
    const s1 = await insertSummary(pool, {
      groupId,
      summaryType: "since",
      parameters: {},
      output: { overview: "s1" },
      model: "m",
    });

    // No mark yet — /סיכום has never run here.
    expect(await getSummaryGroupMark(pool, groupId)).toBeNull();

    const at1 = new Date("2026-07-06T20:00:00Z");
    await upsertSummaryGroupMark(pool, {
      groupId,
      lastSummarizedAt: at1,
      lastSummaryId: s1,
      lastReplyWaMessageId: "wa-1",
    });
    expect(await getSummaryGroupMark(pool, groupId)).toEqual({
      lastSummarizedAt: at1,
      lastSummaryId: s1,
      lastReplyWaMessageId: "wa-1",
    });

    // Conflict on (group_id) → updates in place.
    const s2 = await insertSummary(pool, {
      groupId,
      summaryType: "since",
      parameters: {},
      output: { overview: "s2" },
      model: "m",
    });
    const at2 = new Date("2026-07-06T21:30:00Z");
    await upsertSummaryGroupMark(pool, {
      groupId,
      lastSummarizedAt: at2,
      lastSummaryId: s2,
      lastReplyWaMessageId: "wa-2",
    });
    expect(await getSummaryGroupMark(pool, groupId)).toEqual({
      lastSummarizedAt: at2,
      lastSummaryId: s2,
      lastReplyWaMessageId: "wa-2",
    });
  });

  it("keys the mark per group — two groups stay independent", async () => {
    const a = await upsertGroup(pool, { name: "GM-2a", source: "import" });
    const b = await upsertGroup(pool, { name: "GM-2b", source: "import" });
    const s = await insertSummary(pool, {
      groupId: a,
      summaryType: "since",
      parameters: {},
      output: { overview: "s" },
      model: "m",
    });
    await upsertSummaryGroupMark(pool, {
      groupId: a,
      lastSummarizedAt: new Date("2026-07-06T22:00:00Z"),
      lastSummaryId: s,
      lastReplyWaMessageId: "e",
    });
    expect(await getSummaryGroupMark(pool, b)).toBeNull();
    expect((await getSummaryGroupMark(pool, a))?.lastReplyWaMessageId).toBe("e");
  });
});
