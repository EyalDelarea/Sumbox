import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { upsertMessageEmbedding } from "../db/repositories/message-embeddings.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { searchMessagesHybrid } from "./retrieval.js";

function vec(axis: number): number[] {
  const v = new Array(1024).fill(0);
  v[axis % 1024] = 1;
  return v;
}

async function seed(
  pool: pg.Pool,
  groupId: number,
  text: string,
  key: string,
  axis: number,
  sentAt = "2026-07-10T18:00:00Z",
): Promise<number> {
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
    sentAt: new Date(sentAt),
    dedupeKey: key,
  };
  const { ids } = await insertMessages(pool, [row]);
  await upsertMessageEmbedding(pool, {
    messageId: Number(ids[0]!),
    embedding: vec(axis),
    model: "bge-m3",
    // A truthful hash — these rows stand for "embedded from current content".
    // Asked of Postgres, never computed in JS (see upsertMessageEmbedding).
    contentHash: (await pool.query<{ h: string }>("select md5($1) h", [text])).rows[0].h,
  });
  return Number(ids[0]!);
}

describe("searchMessagesHybrid", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("surfaces an exact-keyword message the semantic ranker buried", async () => {
    const g = await upsertGroup(pool, { name: "HYB-kw", source: "import" });
    // The query vector is vec(1). Distractors sit AT vec(1) (perfect semantic
    // match) but lack the keyword. The answer message is far in vector space
    // (vec(500)) but contains the exact word "משולשים" — semantic-only would
    // rank it last; lexical + fusion pulls it up.
    for (let i = 0; i < 8; i++) await seed(pool, g, `הודעה סתמית ${i}`, `hyb-d${i}`, 1);
    const answerId = await seed(pool, g, "סגרנו על 6 משולשים לאייל", "hyb-ans", 500);

    const hits = await searchMessagesHybrid(
      pool,
      g,
      { embedding: vec(1), text: "כמה משולשים?" },
      5,
    );
    expect(hits.map((h) => h.messageId)).toContain(answerId);
  });

  it("PRIVACY: fusion never surfaces another group's message", async () => {
    const groupA = await upsertGroup(pool, { name: "HYB-A", source: "import" });
    const groupB = await upsertGroup(pool, { name: "HYB-B", source: "import" });
    // B's message is BOTH the perfect vector match AND contains the query keyword.
    await seed(pool, groupB, "הסוד משולשים של קבוצה ב", "hyb-b", 1);
    const inA = await seed(pool, groupA, "משהו רגיל בקבוצה א", "hyb-a", 2);

    const hits = await searchMessagesHybrid(
      pool,
      groupA,
      { embedding: vec(1), text: "משולשים סוד" },
      10,
    );
    const ids = hits.map((h) => h.messageId);
    expect(ids).toContain(inA);
    expect(hits.every((h) => !h.content.includes("קבוצה ב"))).toBe(true); // B unreachable
  });

  it("degrades to semantic-only when the keyword query matches nothing", async () => {
    const g = await upsertGroup(pool, { name: "HYB-degrade", source: "import" });
    const id = await seed(pool, g, "משהו רגיל", "hyb-deg", 1);
    // Query text has no lexical overlap with the content, so lexical returns [].
    const hits = await searchMessagesHybrid(
      pool,
      g,
      { embedding: vec(1), text: "zzz nonexistent qwerty" },
      5,
    );
    expect(hits.map((h) => h.messageId)).toContain(id); // semantic still delivers
  });

  it("returns results in chronological order (reads as a transcript)", async () => {
    const g = await upsertGroup(pool, { name: "HYB-chrono", source: "import" });
    await seed(pool, g, "ראשון משולשים", "hyb-c1", 1, "2026-07-01T10:00:00Z");
    await seed(pool, g, "שני משולשים", "hyb-c2", 1, "2026-07-05T10:00:00Z");
    const hits = await searchMessagesHybrid(pool, g, { embedding: vec(1), text: "משולשים" }, 5);
    const times = hits.map((h) => h.sentAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("retrieval excludes @Aida command messages", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("never returns the @אידה question message itself (self-reference noise)", async () => {
    const g = await upsertGroup(pool, { name: "HYB-selfref", source: "import" });
    // The command message shares the query's keyword ("אתמול") and vector, so it
    // WOULD rank top — but as a command it must be excluded from context.
    await seed(pool, g, "@אידה האם נפגשנו אתמול?", "hyb-cmd", 1);
    const real = await seed(pool, g, "יפה הייתה זרימה טובה אתמול", "hyb-real", 1);

    const hits = await searchMessagesHybrid(
      pool,
      g,
      { embedding: vec(1), text: "נפגשנו אתמול" },
      10,
    );
    expect(hits.some((h) => h.content.includes("@אידה"))).toBe(false); // command excluded
    expect(hits.map((h) => h.messageId)).toContain(real); // real content still there
  });
});
