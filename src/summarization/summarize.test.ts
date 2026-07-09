import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { runSummarize } from "./summarize.js";
import type { Summarizer, SummaryOutput, SummaryPrompt } from "./summarizer.js";

class FakeSummarizer implements Summarizer {
  public calls = 0;
  constructor(private out: SummaryOutput) {}
  async summarize(_p: SummaryPrompt): Promise<SummaryOutput> {
    this.calls++;
    return this.out;
  }
}

const FAKE_OUT: SummaryOutput = { overview: "o" };

describe("runSummarize", () => {
  let pool: pg.Pool;
  let uri: string;

  beforeAll(async () => {
    uri = await createTestDatabase();
    pool = new pg.Pool({ connectionString: uri });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedText(
    groupId: number,
    content: string,
    dedupeKey: string,
    sentAt = new Date(),
  ): Promise<void> {
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
      sentAt,
      dedupeKey,
    };
    await insertMessages(pool, [row]);
  }

  it("persists a summary row and returns ok with the output", async () => {
    const g = await upsertGroup(pool, { name: "SUM-ok", source: "import" });
    await seedText(g, "hello", "ok1");
    const fake = new FakeSummarizer(FAKE_OUT);

    const result = await runSummarize(
      { groupName: "SUM-ok", selection: { last: 100 } },
      { databaseUrl: uri, summarizer: fake, model: "fake", tokenBudget: 24000 },
    );

    expect(result).toMatchObject({ kind: "ok", output: FAKE_OUT });
    const { rows } = await pool.query(
      `SELECT summary_type, parameters, model FROM summaries WHERE group_id=$1`,
      [g],
    );
    expect(rows[0]).toMatchObject({ summary_type: "last_n", model: "fake" });
    expect(rows[0].parameters).toMatchObject({ n: 100 });
  });

  it("stamps usage telemetry (genMs, trigger, requesterId) onto the row", async () => {
    const g = await upsertGroup(pool, { name: "SUM-usage", source: "import" });
    await seedText(g, "hello", "usage1");
    const fake = new FakeSummarizer(FAKE_OUT);
    // Injected clock: start=1250, end=1500 → genMs 250 (deterministic).
    let t = 1000;
    const now = () => (t += 250);

    await runSummarize(
      { groupName: "SUM-usage", selection: { last: 100 } },
      { databaseUrl: uri, summarizer: fake, model: "fake", tokenBudget: 24000, now },
    );

    const { rows } = await pool.query(`SELECT parameters FROM summaries WHERE group_id=$1`, [g]);
    expect(rows[0].parameters).toMatchObject({
      genMs: 250,
      trigger: "scheduled",
      requesterId: null,
    });
  });

  it("returns empty without calling the engine when nothing is selected (FR-019)", async () => {
    await upsertGroup(pool, { name: "SUM-empty", source: "import" });
    const fake = new FakeSummarizer(FAKE_OUT);
    const result = await runSummarize(
      { groupName: "SUM-empty", selection: { last: 100 } },
      { databaseUrl: uri, summarizer: fake, model: "fake", tokenBudget: 24000 },
    );
    expect(result).toEqual({ kind: "empty" });
    expect(fake.calls).toBe(0);
  });

  it("throws for an unknown chat", async () => {
    const fake = new FakeSummarizer(FAKE_OUT);
    await expect(
      runSummarize(
        { groupName: "nope", selection: { last: 100 } },
        { databaseUrl: uri, summarizer: fake, model: "fake", tokenBudget: 24000 },
      ),
    ).rejects.toThrow(/Unknown chat "nope"/);
  });

  it("throws over-budget before calling the engine", async () => {
    const g = await upsertGroup(pool, { name: "SUM-big", source: "import" });
    await seedText(g, "x".repeat(500), "big1");
    const fake = new FakeSummarizer(FAKE_OUT);
    await expect(
      runSummarize(
        { groupName: "SUM-big", selection: { last: 100 } },
        { databaseUrl: uri, summarizer: fake, model: "fake", tokenBudget: 10 },
      ),
    ).rejects.toThrow(/too large/i);
    expect(fake.calls).toBe(0);
  });
});
