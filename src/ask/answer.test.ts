import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { upsertMessageEmbedding } from "../db/repositories/message-embeddings.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import type { AskLlm } from "./answer.js";
import { answerQuestion } from "./answer.js";
import type { Embedder } from "./embedder.js";
import { NOT_IN_CHAT } from "./prompt.js";

function vec(axis: number): number[] {
  const v = new Array(1024).fill(0);
  v[axis % 1024] = 1;
  return v;
}
const fixedEmbedder: Embedder = { embed: async () => vec(1) };

async function seedEmbedded(
  pool: pg.Pool,
  groupId: number,
  text: string,
  key: string,
  axis: number,
) {
  const row: NormalizedMessage & { participantId: number | null } = {
    groupId,
    importId: null,
    source: "import",
    senderName: "Royi",
    messageType: "text",
    textContent: text,
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    externalId: null,
    participantId: null,
    sentAt: new Date("2026-07-10T18:00:00Z"),
    dedupeKey: key,
  };
  const { ids } = await insertMessages(pool, [row]);
  await upsertMessageEmbedding(pool, {
    messageId: Number(ids[0]!),
    embedding: vec(axis),
    model: "bge-m3",
    contentHash: (await pool.query<{ h: string }>("select md5($1) h", [text])).rows[0].h,
  });
  return Number(ids[0]!);
}

describe("answerQuestion", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("retrieves the group's messages and passes them to the LLM, returning its answer", async () => {
    const g = await upsertGroup(pool, { name: "ANS-ok", source: "import" });
    await seedEmbedded(pool, g, "נפגשים ב-21:00 אצל אלכס", "ans-1", 1);
    const llm: AskLlm = { answer: vi.fn(async () => "לפי השיחה, נפגשים ב-21:00 אצל אלכס.") };

    const out = await answerQuestion(
      { pool, embedder: fixedEmbedder, llm },
      {
        groupId: g,
        question: "מתי ואיפה נפגשים?",
      },
    );

    expect(out).toBe("לפי השיחה, נפגשים ב-21:00 אצל אלכס.");
    const prompt = vi.mocked(llm.answer).mock.calls[0]![0];
    expect(prompt.user).toContain("נפגשים ב-21:00 אצל אלכס"); // the group's message reached the LLM
  });

  it("returns NOT_INDEXED (not NOT_IN_CHAT) when the group has no embeddings yet", async () => {
    // An un-indexed group must not be told "I didn't find it in the chat" — that
    // is a false claim about the conversation; it's an operational state.
    const { NOT_INDEXED } = await import("./prompt.js");
    const g = await upsertGroup(pool, { name: "ANS-empty", source: "import" });
    const llm: AskLlm = { answer: vi.fn(async () => "should not be called") };
    const out = await answerQuestion(
      { pool, embedder: fixedEmbedder, llm },
      { groupId: g, question: "מה קורה?" },
    );
    expect(out).toBe(NOT_INDEXED);
    expect(llm.answer).not.toHaveBeenCalled(); // never asks the LLM with no context
  });

  it("PRIVACY: never feeds another group's message to the LLM", async () => {
    const groupA = await upsertGroup(pool, { name: "ANS-A", source: "import" });
    const groupB = await upsertGroup(pool, { name: "ANS-B", source: "import" });
    // B's secret is the PERFECT match for the query vector.
    await seedEmbedded(pool, groupB, "הסוד של קבוצה ב", "ans-b", 1);
    await seedEmbedded(pool, groupA, "משהו רגיל של קבוצה א", "ans-a", 2);
    const llm: AskLlm = { answer: vi.fn(async () => "ok") };

    await answerQuestion(
      { pool, embedder: fixedEmbedder, llm },
      {
        groupId: groupA,
        question: "מה הסוד?",
      },
    );

    const prompt = vi.mocked(llm.answer).mock.calls[0]![0];
    expect(prompt.user).not.toContain("הסוד של קבוצה ב"); // B's data never reaches A's answer
  });

  it("falls back to the refusal when the LLM returns empty", async () => {
    const g = await upsertGroup(pool, { name: "ANS-blank", source: "import" });
    await seedEmbedded(pool, g, "משהו", "ans-blank-1", 1);
    const llm: AskLlm = { answer: vi.fn(async () => "   ") };
    const out = await answerQuestion(
      { pool, embedder: fixedEmbedder, llm },
      {
        groupId: g,
        question: "?",
      },
    );
    expect(out).toBe(NOT_IN_CHAT);
  });
});
