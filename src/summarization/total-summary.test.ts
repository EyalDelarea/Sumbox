import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertScope } from "../db/repositories/chat-scopes.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import type { SummaryPrompt } from "./summarizer.js";
import { generateTotalSummary } from "./total-summary.js";

describe("generateTotalSummary", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(groupId: number, sentAt: Date, key: string, text: string) {
    const participantId = await upsertParticipant(pool, "Dana");
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "Dana",
      messageType: "text",
      textContent: text,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      dedupeKey: key,
      sentAt,
    };
    await insertMessages(pool, [row]);
  }

  // Fake streaming summarizer: echoes a marker plus the first user line so the
  // test can assert map vs reduce phases were both invoked.
  async function* fakeStream(prompt: SummaryPrompt): AsyncGenerator<string> {
    if (prompt.system.includes("דורש תשומת לב")) {
      yield "## דורש תשומת לב\n- [x] reduced";
    } else {
      yield "## תקציר\nmapped";
    }
  }

  it("produces a per-chat section per active chat plus reduced highlights", async () => {
    const since = new Date("2026-06-06T00:00:00.000Z");
    const work = await upsertGroup(pool, { name: "Work", source: "import" });
    const fam = await upsertGroup(pool, { name: "Family", source: "import" });
    await seed(work, new Date("2026-06-06T09:00:00.000Z"), "w1", "תקציב");
    await seed(fam, new Date("2026-06-06T09:30:00.000Z"), "f1", "שבת");
    // Default-off scoping: include the seeded chats so they're summarized.
    await upsertScope(pool, { groupId: work, included: true });
    await upsertScope(pool, { groupId: fam, included: true });

    const statuses: string[] = [];
    const out = await generateTotalSummary(
      { pool, summarizeStream: fakeStream, tokenBudget: 100_000 },
      { since },
      { onChatStart: (i) => statuses.push(i.name) },
    );

    expect(out.perChat.map((c) => c.name).sort()).toEqual(["Family", "Work"]);
    expect(out.perChat[0]!.summary).toContain("mapped");
    expect(out.highlights).toContain("reduced");
    expect(statuses.sort()).toEqual(["Family", "Work"]);
  });

  it("isolates per-chat failures: one failing chat does not abort the others", async () => {
    const since = new Date("2026-06-07T00:00:00.000Z");
    const aaa = await upsertGroup(pool, { name: "Aaa", source: "import" });
    const bbb = await upsertGroup(pool, { name: "Bbb", source: "import" });
    await seed(aaa, new Date("2026-06-07T09:00:00.000Z"), "a1", "BOOM");
    await seed(bbb, new Date("2026-06-07T09:30:00.000Z"), "b1", "hello");
    await upsertScope(pool, { groupId: aaa, included: true });
    await upsertScope(pool, { groupId: bbb, included: true });

    async function* fakeStreamWithFailure(prompt: SummaryPrompt): AsyncGenerator<string> {
      if (prompt.system.includes("דורש תשומת לב")) {
        yield "## דורש תשומת לב\n- [x] reduced";
      } else if (prompt.user.includes("BOOM")) {
        throw new Error("over-budget for Aaa");
      } else {
        yield "## תקציר\nmapped";
      }
    }

    const out = await generateTotalSummary(
      { pool, summarizeStream: fakeStreamWithFailure, tokenBudget: 100_000 },
      { since },
    );

    expect(out.perChat.length).toBeGreaterThanOrEqual(1);
    expect(out.perChat.map((c) => c.name)).toContain("Bbb");
    expect(out.perChat.map((c) => c.name)).not.toContain("Aaa");
    expect(out.highlights).toContain("reduced");
  });

  it("returns the empty-range message when no chat is active", async () => {
    const since = new Date("2999-01-01T00:00:00.000Z");
    const out = await generateTotalSummary(
      { pool, summarizeStream: fakeStream, tokenBudget: 100_000 },
      { since },
    );
    expect(out.perChat).toEqual([]);
    expect(out.highlights).toContain("אין פעילות");
  });
});
