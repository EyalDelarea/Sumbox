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

  it("throws over-budget", async () => {
    const g = await upsertGroup(pool, { name: "PREP-big", source: "import" });
    await seedText(g, "x".repeat(500), "pbig");
    await expect(prepareSummary(pool, "PREP-big", { last: 100 }, 10)).rejects.toThrow(/too large/i);
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
