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
  externalId: string | null = null,
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
    externalId,
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

describe("retrieval excludes @Aida's OWN replies", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  /**
   * The 2026-08-19 incident, as a regression test.
   *
   * Under a leading question she invented a confrontation between two people.
   * That reply was then ingested as an ordinary group message, so SEARCH began
   * returning it as evidence — and she repeated the claim unprompted, on neutral
   * questions, days later. An agent that retrieves its own past output as "what
   * the group said" launders a guess into a source.
   *
   * Excluding her replies from RETRIEVAL only. The recency window still shows
   * them (labelled as hers), so follow-ups and "what did you just say" keep
   * working — she may remember what she said, she may not cite herself as proof.
   */
  it("never returns her own reply as evidence, even when it ranks top", async () => {
    const g = await upsertGroup(pool, { name: "HYB-selfecho", source: "import" });
    // Her fabrication shares the query's keyword AND vector, so it would rank
    // first — which is exactly what happened in the field.
    await seed(
      pool,
      g,
      "תכף תכף... נראה שהיה עימות בין בר לאייל",
      "hyb-hers",
      2,
      undefined,
      "ext-aida-1",
    );
    const human = await seed(pool, g, "מחר אנחנו נפגשים בערב", "hyb-human", 2);
    await pool.query(
      `INSERT INTO aida_messages (group_id, external_id) VALUES ($1, 'ext-aida-1')`,
      [g],
    );

    const hits = await searchMessagesHybrid(pool, g, { embedding: vec(2), text: "עימות" }, 10);
    expect(hits.some((h) => h.content.includes("עימות"))).toBe(false);
    expect(hits.map((h) => h.messageId)).toContain(human);
  });

  it("still returns a human message that merely quotes her", async () => {
    // The exclusion keys on aida_messages, not on her catchphrase — a member
    // quoting or mocking her is real conversation and must stay searchable.
    const g = await upsertGroup(pool, { name: "HYB-quoteher", source: "import" });
    const quoted = await seed(pool, g, 'רועי אמר "תכף תכף" בצחוק', "hyb-quote", 3);
    const hits = await searchMessagesHybrid(pool, g, { embedding: vec(3), text: "תכף" }, 10);
    expect(hits.map((h) => h.messageId)).toContain(quoted);
  });
});
