import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { createTestDatabase } from "../test/db.js";
import { buildCorpus } from "./corpus.js";

async function ask(pool: pg.Pool, groupId: number, question: string | null, sentAt: string) {
  await pool.query(
    `INSERT INTO aida_messages (group_id, external_id, question, sent_at) VALUES ($1,$2,$3,$4)`,
    [groupId, `ext-${Math.random()}`, question, sentAt],
  );
}

describe("buildCorpus", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("carries each question's OWN timestamp as asOf", async () => {
    // Load-bearing: a replay must reconstruct the window as it was when the
    // question was asked, or the corpus drifts silently as new messages arrive
    // and two runs a week apart stop being comparable.
    const g = await upsertGroup(pool, { name: `c1-${Math.random()}`, source: "import" });
    await ask(pool, g, "מה קורה?", "2026-07-20T10:00:00Z");
    const [item] = await buildCorpus(pool, { groupId: g });
    expect(item?.asOf.toISOString()).toBe("2026-07-20T10:00:00.000Z");
    expect(item?.groupId).toBe(g);
  });

  it("de-duplicates a repeated question, keeping the first asking", async () => {
    // Someone testing a probe eight times must not get eight votes — and the
    // FIRST asking is the one whose window is not yet polluted by her own
    // answers to it.
    const g = await upsertGroup(pool, { name: `c2-${Math.random()}`, source: "import" });
    await ask(pool, g, "מי הכי מעצבן?", "2026-07-20T10:00:00Z");
    await ask(pool, g, "מי הכי מעצבן?", "2026-07-20T11:00:00Z");
    await ask(pool, g, "  מי הכי מעצבן?  ", "2026-07-20T12:00:00Z");
    const items = await buildCorpus(pool, { groupId: g });
    expect(items).toHaveLength(1);
    expect(items[0]!.asOf.toISOString()).toBe("2026-07-20T10:00:00.000Z");
  });

  it("drops empty questions — a bare mention has nothing to replay", async () => {
    const g = await upsertGroup(pool, { name: `c3-${Math.random()}`, source: "import" });
    await ask(pool, g, null, "2026-07-20T10:00:00Z");
    await ask(pool, g, "   ", "2026-07-20T10:01:00Z");
    await ask(pool, g, "שאלה אמיתית", "2026-07-20T10:02:00Z");
    expect((await buildCorpus(pool, { groupId: g })).map((i) => i.question)).toEqual([
      "שאלה אמיתית",
    ]);
  });

  it("scopes to one group, and returns chronological order", async () => {
    const a = await upsertGroup(pool, { name: `c4-${Math.random()}`, source: "import" });
    const b = await upsertGroup(pool, { name: `c5-${Math.random()}`, source: "import" });
    await ask(pool, a, "שנייה", "2026-07-20T12:00:00Z");
    await ask(pool, a, "ראשונה", "2026-07-20T10:00:00Z");
    await ask(pool, b, "אחרת", "2026-07-20T11:00:00Z");
    const items = await buildCorpus(pool, { groupId: a });
    // Chronological so a truncated run is a coherent slice of history, not an
    // arbitrary one.
    expect(items.map((i) => i.question)).toEqual(["ראשונה", "שנייה"]);
  });

  it("honours limit after ordering, not before", async () => {
    const g = await upsertGroup(pool, { name: `c6-${Math.random()}`, source: "import" });
    await ask(pool, g, "ב", "2026-07-20T11:00:00Z");
    await ask(pool, g, "א", "2026-07-20T10:00:00Z");
    expect((await buildCorpus(pool, { groupId: g, limit: 1 }))[0]!.question).toBe("א");
  });
});
