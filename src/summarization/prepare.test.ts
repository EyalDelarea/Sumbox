import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { prepareSummary } from "./prepare.js";

describe("prepareSummary", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedText(groupId: number, content: string, dedupeKey: string): Promise<void> {
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "Dana",
      messageType: "text",
      textContent: content,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId: null,
      sentAt: new Date("2026-01-01T10:00:00Z"),
      dedupeKey,
    };
    await insertMessages(pool, [row]);
  }

  it("returns a ready plan with prompt, type, params, and message count", async () => {
    const g = await upsertGroup(pool, { name: "PREP-ok", source: "import" });
    await seedText(g, "hello world", "p1");
    const prepared = await prepareSummary(pool, "PREP-ok", { last: 100 }, 24000);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      expect(prepared.groupId).toBe(g);
      expect(prepared.summaryType).toBe("last_n");
      expect(prepared.parameters).toMatchObject({ n: 100 });
      expect(prepared.messageCount).toBe(1);
      expect(prepared.prompt.user).toContain("hello world");
    }
  });

  it("returns empty when nothing is selected", async () => {
    await upsertGroup(pool, { name: "PREP-empty", source: "import" });
    expect(await prepareSummary(pool, "PREP-empty", { last: 100 }, 24000)).toEqual({
      kind: "empty",
    });
  });

  it("throws for an unknown chat", async () => {
    await expect(prepareSummary(pool, "nope", { last: 100 }, 24000)).rejects.toThrow(
      /Unknown chat "nope"/,
    );
  });

  it("trims an over-budget selection to the newest messages that fit, instead of throwing", async () => {
    // It used to throw "Selection too large". That guard almost never fired,
    // because the chars/4 estimate under-counted Hebrew ~2x — so oversized
    // prompts sailed through and got truncated mid-sentence by num_ctx instead.
    // With the estimate corrected, a plain 3-day /סיכום would now hit the guard,
    // and an error is a worse answer than a slightly narrower summary.
    const g = await upsertGroup(pool, { name: "PREP-trim", source: "import" });
    for (let i = 0; i < 8; i++) await seedText(g, `הודעה מספר ${i} `.repeat(20), `ptrim${i}`);

    // The system prompt alone costs ~1394 tokens; each seeded message ~178.
    // 2200 fits the instructions plus roughly four messages, so some must drop.
    const prepared = await prepareSummary(pool, "PREP-trim", { last: 100 }, 2200);
    if (prepared.kind !== "ready") throw new Error("expected ready");

    expect(prepared.messageCount).toBeGreaterThan(0);
    expect(prepared.messageCount).toBeLessThan(8); // some were dropped
    expect(prepared.droppedCount).toBe(8 - prepared.messageCount);
    expect(prepared.estimatedTokens).toBeLessThanOrEqual(2200); // the budget HOLDS
    // The row records that this summary covers less than was asked for.
    expect(prepared.parameters["trimmed"]).toBe(true);
    expect(prepared.parameters["droppedCount"]).toBe(prepared.droppedCount);
  });

  it("keeps the NEWEST messages when it trims, not the oldest", async () => {
    const g = await upsertGroup(pool, { name: "PREP-newest", source: "import" });
    await seedText(g, "העתיקה ביותר ".repeat(40), "pold");
    await seedText(g, "החדשה ביותר", "pnew");

    // Fits the instructions + the short new message, but not the long old one.
    const prepared = await prepareSummary(pool, "PREP-newest", { last: 100 }, 1500);
    if (prepared.kind !== "ready") throw new Error("expected ready");
    // A catch-up summary of a too-wide window should cover what just happened.
    expect(prepared.prompt.user).toContain("החדשה ביותר");
  });

  it("reports droppedCount 0 and no trimmed flag when everything fits", async () => {
    const g = await upsertGroup(pool, { name: "PREP-fits", source: "import" });
    await seedText(g, "שלום", "pfit");
    const prepared = await prepareSummary(pool, "PREP-fits", { last: 100 }, 12000);
    if (prepared.kind !== "ready") throw new Error("expected ready");
    expect(prepared.droppedCount).toBe(0);
    expect(prepared.parameters["trimmed"]).toBeUndefined();
  });

  it("derives since type/params", async () => {
    const g = await upsertGroup(pool, { name: "PREP-since", source: "import" });
    await seedText(g, "hi", "psince");
    const prepared = await prepareSummary(
      pool,
      "PREP-since",
      { since: new Date("2025-12-01T00:00:00Z") },
      24000,
    );
    if (prepared.kind === "ready") {
      expect(prepared.summaryType).toBe("since");
      expect(prepared.parameters).toMatchObject({ since: "2025-12-01" });
    } else {
      throw new Error("expected ready");
    }
  });
});
