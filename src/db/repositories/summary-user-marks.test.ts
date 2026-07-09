import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import { upsertParticipant } from "./participants.js";
import { insertSummary } from "./summaries.js";
import { getSummaryUserMark, upsertSummaryUserMark } from "./summary-user-marks.js";

describe("summary_user_marks", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("upserts + reads a per-user mark, and updates on conflict", async () => {
    const groupId = await upsertGroup(pool, { name: "UM-1", source: "import" });
    const pid = await upsertParticipant(pool, "Dana Cohen");
    const s1 = await insertSummary(pool, {
      groupId,
      summaryType: "since",
      parameters: {},
      output: { overview: "s1" },
      model: "m",
    });

    // No mark yet.
    expect(await getSummaryUserMark(pool, groupId, pid)).toBeNull();

    const at1 = new Date("2026-07-06T20:00:00Z");
    await upsertSummaryUserMark(pool, {
      groupId,
      participantId: pid,
      lastSummarizedAt: at1,
      lastSummaryId: s1,
      lastReplyWaMessageId: "wa-1",
    });
    expect(await getSummaryUserMark(pool, groupId, pid)).toEqual({
      lastSummarizedAt: at1,
      lastSummaryId: s1,
      lastReplyWaMessageId: "wa-1",
    });

    // Conflict on (tenant, group, participant) → updates in place.
    const s2 = await insertSummary(pool, {
      groupId,
      summaryType: "since",
      parameters: {},
      output: { overview: "s2" },
      model: "m",
    });
    const at2 = new Date("2026-07-06T21:30:00Z");
    await upsertSummaryUserMark(pool, {
      groupId,
      participantId: pid,
      lastSummarizedAt: at2,
      lastSummaryId: s2,
      lastReplyWaMessageId: "wa-2",
    });
    expect(await getSummaryUserMark(pool, groupId, pid)).toEqual({
      lastSummarizedAt: at2,
      lastSummaryId: s2,
      lastReplyWaMessageId: "wa-2",
    });
  });

  it("keeps two participants' marks independent", async () => {
    const groupId = await upsertGroup(pool, { name: "UM-2", source: "import" });
    const eyal = await upsertParticipant(pool, "Eyal");
    const royi = await upsertParticipant(pool, "Noa");
    const s = await insertSummary(pool, {
      groupId,
      summaryType: "since",
      parameters: {},
      output: { overview: "s" },
      model: "m",
    });
    const now = new Date("2026-07-06T22:00:00Z");
    await upsertSummaryUserMark(pool, {
      groupId,
      participantId: eyal,
      lastSummarizedAt: now,
      lastSummaryId: s,
      lastReplyWaMessageId: "e",
    });
    expect(await getSummaryUserMark(pool, groupId, royi)).toBeNull();
    expect((await getSummaryUserMark(pool, groupId, eyal))?.lastReplyWaMessageId).toBe("e");
  });
});
