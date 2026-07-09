import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertSummary } from "../db/repositories/summaries.js";
import { createTestDatabase } from "../test/db.js";
import { prepareRegenerate } from "./prepare-regenerate.js";

/** Insert a readable message and return its (sentAt, id). */
async function addMsg(pool: pg.Pool, groupId: number, sentAt: string, text: string) {
  // The messages schema uses dedupe_key (not wa_message_id) and participant_id (not sender).
  // sender is resolved at select-time via COALESCE(p.display_name, 'Unknown').
  const { rows } = await pool.query<{ id: string; sent_at: Date }>(
    `INSERT INTO messages (group_id, dedupe_key, source, text_content, sent_at, message_type)
     VALUES ($1, $2, 'import', $3, $4, 'text') RETURNING id, sent_at`,
    [groupId, `wa-${sentAt}-${text}`, text, sentAt],
  );
  return { id: Number(rows[0].id), sentAt: rows[0].sent_at };
}

describe("prepareRegenerate", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns not-found for an unknown summary id", async () => {
    expect((await prepareRegenerate(pool, 999_999, "too_long", 24_000)).kind).toBe("not-found");
  });

  it("reconstructs the (fromExclusive, toInclusive] id range and builds an adjust prompt", async () => {
    const groupId = await upsertGroup(pool, { name: "REGEN-range", source: "import" });
    const m1 = await addMsg(pool, groupId, "2026-01-01T10:00:00Z", "one");
    const m2 = await addMsg(pool, groupId, "2026-01-01T10:01:00Z", "two");
    const m3 = await addMsg(pool, groupId, "2026-01-01T10:02:00Z", "three");
    const m4 = await addMsg(pool, groupId, "2026-01-01T10:03:00Z", "four-after-window");

    // Summary covered (m1, m3]: fromExclusive = m1, toInclusive = m3 → m2 + m3 only.
    const summaryId = await insertSummary(pool, {
      groupId,
      summaryType: "watermark",
      parameters: {
        fromExclusive: { sentAt: m1.sentAt.toISOString(), messageId: m1.id },
        toInclusive: { sentAt: m3.sentAt.toISOString(), messageId: m3.id },
        messageCount: 2,
        usedFallback: false,
      },
      output: { overview: "o" },
      model: "fake",
    });

    const prepared = await prepareRegenerate(pool, summaryId, "too_long", 24_000);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    expect(prepared.groupId).toBe(groupId);
    expect(prepared.regeneratedFromId).toBe(summaryId);
    expect(prepared.messageCount).toBe(2);
    // m4 is after toInclusive → excluded; m1 is the exclusive lower bound → excluded.
    expect(prepared.prompt.user).toContain("two");
    expect(prepared.prompt.user).toContain("three");
    expect(prepared.prompt.user).not.toContain("four-after-window");
    expect(prepared.prompt.user).not.toContain("Unknown: one");
    // too_long appended its adjustment line.
    expect(prepared.prompt.system).toContain("Adjustment: the previous summary was too long");
  });

  it("first-run (fromExclusive null) replays the last messageCount up to toInclusive", async () => {
    const groupId = await upsertGroup(pool, { name: "REGEN-firstrun", source: "import" });
    await addMsg(pool, groupId, "2026-02-01T10:00:00Z", "old1");
    await addMsg(pool, groupId, "2026-02-01T10:01:00Z", "old2");
    const keep1 = await addMsg(pool, groupId, "2026-02-01T10:02:00Z", "keep1");
    const keep2 = await addMsg(pool, groupId, "2026-02-01T10:03:00Z", "keep2");

    const summaryId = await insertSummary(pool, {
      groupId,
      summaryType: "watermark",
      parameters: {
        fromExclusive: null,
        toInclusive: { sentAt: keep2.sentAt.toISOString(), messageId: keep2.id },
        messageCount: 2,
        usedFallback: true,
      },
      output: { overview: "o" },
      model: "fake",
    });
    void keep1;

    const prepared = await prepareRegenerate(pool, summaryId, "missed", 24_000);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    expect(prepared.messageCount).toBe(2);
    expect(prepared.prompt.user).toContain("keep1");
    expect(prepared.prompt.user).toContain("keep2");
    expect(prepared.prompt.user).not.toContain("old1");
  });
});
