import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import {
  searchMessagesByEmbedding,
  selectUnembeddedContentMessages,
  upsertMessageEmbedding,
} from "./message-embeddings.js";
import { insertMessages } from "./messages.js";

/** A 1024-dim unit-ish vector pointing mostly along axis `axis`. bge-m3 dim. */
function vec(axis: number): number[] {
  const v = new Array(1024).fill(0);
  v[axis] = 1;
  return v;
}

async function seed(pool: pg.Pool, groupId: number, text: string, key: string): Promise<number> {
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
    participantId: null,
    sentAt: new Date("2026-01-01T10:00:00Z"),
    dedupeKey: key,
  };
  const { ids } = await insertMessages(pool, [row]);
  // pg returns bigint ids as strings; the repo normalizes to number, so match it.
  return Number(ids[0]!);
}

describe("message-embeddings repository", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("round-trips an embedding and finds it by similarity", async () => {
    const g = await upsertGroup(pool, { name: "EMB-rt", source: "import" });
    const id = await seed(pool, g, "נפגשים בשמונה בבית של רועי", "emb-rt-1");
    await upsertMessageEmbedding(pool, { messageId: id, embedding: vec(3), model: "bge-m3" });

    const hits = await searchMessagesByEmbedding(pool, g, vec(3), 5);
    expect(hits.map((h) => h.messageId)).toContain(id);
    expect(hits.find((h) => h.messageId === id)?.content).toContain("נפגשים בשמונה");
  });

  it("upsert is idempotent on message_id (re-embed never duplicates or errors)", async () => {
    const g = await upsertGroup(pool, { name: "EMB-idem", source: "import" });
    const id = await seed(pool, g, "שלום", "emb-idem-1");
    await upsertMessageEmbedding(pool, { messageId: id, embedding: vec(1), model: "bge-m3" });
    await upsertMessageEmbedding(pool, { messageId: id, embedding: vec(2), model: "bge-m3" });
    const { rows } = await pool.query(
      "select count(*) c from message_embeddings where message_id=$1",
      [id],
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  // ── THE PRIVACY GUARD ───────────────────────────────────────────────────────
  it("NEVER returns another group's message — even when it is the closest match", async () => {
    const groupA = await upsertGroup(pool, { name: "EMB-A", source: "import" });
    const groupB = await upsertGroup(pool, { name: "EMB-B", source: "import" });

    const secretInB = await seed(pool, groupB, "הסוד של קבוצה ב", "emb-leak-b");
    const inA = await seed(pool, groupA, "משהו של קבוצה א", "emb-leak-a");

    // Make B's message the PERFECT match for the query (distance 0), and A's far.
    const query = vec(7);
    await upsertMessageEmbedding(pool, { messageId: secretInB, embedding: query, model: "bge-m3" });
    await upsertMessageEmbedding(pool, { messageId: inA, embedding: vec(500), model: "bge-m3" });

    // Search group A with a query identical to B's vector. If the group filter
    // failed, B's message would rank #1. It must not appear at all.
    const hits = await searchMessagesByEmbedding(pool, groupA, query, 10);
    const ids = hits.map((h) => h.messageId);
    expect(ids).toContain(inA); // A's own message is retrievable
    expect(ids).not.toContain(secretInB); // B's is physically unreachable from A
    expect(hits.every((h) => !h.content.includes("הסוד"))).toBe(true);
  });

  it("lists unembedded content messages, excluding already-embedded ones", async () => {
    const g = await upsertGroup(pool, { name: "EMB-unemb", source: "import" });
    const a = await seed(pool, g, "הודעה ראשונה", "emb-unemb-a");
    const b = await seed(pool, g, "הודעה שנייה", "emb-unemb-b");
    await upsertMessageEmbedding(pool, { messageId: a, embedding: vec(9), model: "bge-m3" });

    const pending = await selectUnembeddedContentMessages(pool, 100);
    const ids = pending.map((m) => m.id);
    expect(ids).toContain(b); // not embedded → listed
    expect(ids).not.toContain(a); // already embedded → excluded
  });

  it("does not list system or empty-content messages as pending", async () => {
    const g = await upsertGroup(pool, { name: "EMB-sys", source: "import" });
    const good = await seed(pool, g, "יש תוכן", "emb-sys-good");
    await pool.query(
      `INSERT INTO messages (group_id, source, message_type, text_content, dedupe_key, sent_at)
       VALUES ($1,'import','system','',$2, now())`,
      [g, "emb-sys-system"],
    );
    const pending = await selectUnembeddedContentMessages(pool, 100);
    const ids = pending.map((m) => m.id);
    expect(ids).toContain(good);
    // the system row has empty content AND is system → doubly excluded
    expect(pending.every((m) => m.content.trim() !== "")).toBe(true);
  });
});

describe("searchMessagesLexical", () => {
  let pool2: pg.Pool;
  beforeAll(async () => {
    pool2 = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool2?.end();
  }, 30_000);

  it("finds an exact keyword and stays scoped to the group", async () => {
    const { searchMessagesLexical } = await import("./message-embeddings.js");
    const gA = await upsertGroup(pool2, { name: "LEX-A", source: "import" });
    const gB = await upsertGroup(pool2, { name: "LEX-B", source: "import" });
    const inA = await seed(pool2, gA, "תובל 21 רמת גן משרד 66", "lex-a");
    await seed(pool2, gB, "תובל אחר בקבוצה ב", "lex-b"); // same keyword, other group

    const hits = await searchMessagesLexical(pool2, gA, "כתובת תובל", 10);
    const ids = hits.map((h) => h.messageId);
    expect(ids).toContain(inA);
    expect(hits.every((h) => !h.content.includes("קבוצה ב"))).toBe(true); // B excluded
  });

  it("returns [] for a query with no searchable words (never throws)", async () => {
    const { searchMessagesLexical } = await import("./message-embeddings.js");
    const g = await upsertGroup(pool2, { name: "LEX-empty", source: "import" });
    await seed(pool2, g, "משהו", "lex-empty");
    expect(await searchMessagesLexical(pool2, g, "!!! ??? ...", 10)).toEqual([]);
  });
});
