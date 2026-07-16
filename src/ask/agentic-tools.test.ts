import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { upsertMessageEmbedding } from "../db/repositories/message-embeddings.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { makeSearchChatTool } from "./agentic-tools.js";
import type { Embedder } from "./embedder.js";

function vec(a: number) {
  const v = new Array(1024).fill(0);
  v[a] = 1;
  return v;
}

async function seed(pool: pg.Pool, g: number, text: string, key: string, axis: number) {
  const row: NormalizedMessage & { participantId: number | null } = {
    groupId: g,
    importId: null,
    source: "import",
    senderName: "Dana",
    messageType: "text",
    textContent: text,
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    externalId: null,
    participantId: null,
    sentAt: new Date("2026-07-10T10:00:00Z"),
    dedupeKey: key,
  };
  const { ids } = await insertMessages(pool, [row]);
  await upsertMessageEmbedding(pool, {
    messageId: Number(ids[0]!),
    embedding: vec(axis),
    model: "bge-m3",
  });
  return Number(ids[0]!);
}

describe("makeSearchChatTool", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: await createTestDatabase(),
    });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("searches ONLY the bound group and fuses the original question into the embed", async () => {
    const gA = await upsertGroup(pool, { name: "AT-A", source: "import" });
    const gB = await upsertGroup(pool, { name: "AT-B", source: "import" });
    await seed(pool, gB, "הסוד של קבוצה ב", "at-b", 1);
    const inA = await seed(pool, gA, "משהו של קבוצה א", "at-a", 2);
    const embedCalls: string[] = [];
    const embedder: Embedder = {
      embed: async (t) => {
        embedCalls.push(t);
        return vec(2);
      },
    };

    const t = makeSearchChatTool({
      pool,
      embedder,
      groupId: gA,
      question: "מה קורה בקבוצה?",
    });
    const out = await t.execute!({ query: "משהו" }, {} as never);

    expect(String(out)).toContain("משהו של קבוצה א"); // A's own message
    expect(String(out)).not.toContain("הסוד של קבוצה ב"); // B unreachable
    expect(embedCalls[0]).toContain("מה קורה בקבוצה?"); // question fused in
    expect(embedCalls[0]).toContain("משהו"); // model query fused in
  });
});
