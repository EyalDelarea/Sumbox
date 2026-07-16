import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMediaAnalysis } from "../db/repositories/media-analyses.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import type { Embedder } from "./embedder.js";
import { embedPendingBatch } from "./embedding-sweep.js";

function vec(seed: number): number[] {
  const v = new Array(1024).fill(0);
  v[seed % 1024] = 1;
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
  return Number(ids[0]!);
}

/** Embedder that returns a deterministic vector, or throws for a flagged text. */
function fakeEmbedder(throwOn?: string): Embedder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    embed: async (text: string) => {
      calls.push(text);
      if (throwOn && text.includes(throwOn)) throw new Error("boom");
      return vec(text.length);
    },
  };
}

describe("embedPendingBatch", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("embeds pending messages and persists them", async () => {
    const g = await upsertGroup(pool, { name: "SWEEP-ok", source: "import" });
    const a = await seed(pool, g, "הודעה א", "sw-a");
    const b = await seed(pool, g, "הודעה ב שונה", "sw-b");
    const embedder = fakeEmbedder();

    const r = await embedPendingBatch({ pool, embedder, model: "bge-m3" }, 100);

    expect(r.embedded).toBeGreaterThanOrEqual(2);
    const { rows } = await pool.query(
      "select count(*) c from message_embeddings where message_id = any($1)",
      [[a, b]],
    );
    expect(Number(rows[0].c)).toBe(2);
  });

  it("skips already-embedded messages on the next pass (idempotent, no rework)", async () => {
    const g = await upsertGroup(pool, { name: "SWEEP-idem", source: "import" });
    await seed(pool, g, "ייחודי לבדיקה", "sw-idem-1");
    const embedder = fakeEmbedder();

    await embedPendingBatch({ pool, embedder, model: "bge-m3" }, 100);
    const firstCalls = embedder.calls.length;
    await embedPendingBatch({ pool, embedder, model: "bge-m3" }, 100);
    // Second pass must not re-embed the same message.
    expect(embedder.calls.filter((c) => c.includes("ייחודי לבדיקה")).length).toBe(1);
    expect(embedder.calls.length).toBe(firstCalls);
  });

  it("a single embed failure is skipped, not fatal — the batch still makes progress", async () => {
    const g = await upsertGroup(pool, { name: "SWEEP-fail", source: "import" });
    const good = await seed(pool, g, "טוב לבדיקת כשל", "sw-good");
    await seed(pool, g, "רעיל", "sw-bad"); // fakeEmbedder throws on "רעיל"
    const embedder = fakeEmbedder("רעיל");
    const log = { info: vi.fn(), warn: vi.fn() };

    const r = await embedPendingBatch({ pool, embedder, model: "bge-m3", log }, 100);

    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.embedded).toBeGreaterThanOrEqual(1);
    expect(log.warn).toHaveBeenCalled(); // the failure was surfaced, not swallowed
    const { rows } = await pool.query(
      "select count(*) c from message_embeddings where message_id=$1",
      [good],
    );
    expect(Number(rows[0].c)).toBe(1); // the good one still got embedded
  });

  // ── RE-EMBED ON ENRICHMENT (#45) ────────────────────────────────────────────

  it("re-embeds a message whose description arrived after it was embedded", async () => {
    const g = await upsertGroup(pool, { name: "SWEEP-enrich", source: "import" });
    const id = await seed(pool, g, "קפצו לראות", "sw-enrich-1");
    const embedder = fakeEmbedder();

    // Embedded on the caption alone.
    await embedPendingBatch({ pool, embedder, model: "bge-m3" }, 100);
    expect(embedder.calls).toContain("קפצו לראות");

    await insertMediaAnalysis(pool, {
      messageId: id,
      kind: "image",
      description: "צלחת פסטה על שולחן",
      engine: "test",
      status: "completed",
    });
    await embedPendingBatch({ pool, embedder, model: "bge-m3" }, 100);

    // Re-embedded on caption + description — the whole point of the fix.
    expect(embedder.calls.some((c) => c.includes("צלחת פסטה על שולחן"))).toBe(true);
    const { rows } = await pool.query(
      "select count(*) c from message_embeddings where message_id=$1",
      [id],
    );
    expect(Number(rows[0].c)).toBe(1); // refreshed in place, not duplicated
  });

  it("CONVERGES — after a full sweep, nothing re-selects (guards a GPU busy-loop)", async () => {
    // If the hash written by the sweep ever disagreed with the hash the SELECT
    // computes, every enriched row would re-select on EVERY tick forever, pinning
    // the local GPU while looking like ordinary activity. This is the test that
    // fails loudly if that ever becomes possible.
    const g = await upsertGroup(pool, { name: "SWEEP-conv", source: "import" });
    const withDesc = await seed(pool, g, "עם תיאור", "sw-conv-1");
    await seed(pool, g, "טקסט רגיל", "sw-conv-2");
    await insertMediaAnalysis(pool, {
      messageId: withDesc,
      kind: "image",
      description: "תיאור כלשהו",
      engine: "test",
      status: "completed",
    });

    await embedPendingBatch({ pool, embedder: fakeEmbedder(), model: "bge-m3" }, 100);

    const second = fakeEmbedder();
    const r = await embedPendingBatch({ pool, embedder: second, model: "bge-m3" }, 100);
    expect(r.embedded).toBe(0);
    expect(second.calls).toEqual([]); // the sweep has genuinely settled
  });

  it("leaves the old hash intact when an embed fails, so it retries next pass", async () => {
    // A failure must not mark the message clean — that would silently strand a
    // stale vector forever.
    const g = await upsertGroup(pool, { name: "SWEEP-keep", source: "import" });
    const id = await seed(pool, g, "רעיל", "sw-keep-1");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await embedPendingBatch({ pool, embedder: fakeEmbedder("רעיל"), model: "bge-m3", log }, 100);
    const { rows } = await pool.query(
      "select count(*) c from message_embeddings where message_id=$1",
      [id],
    );
    expect(Number(rows[0].c)).toBe(0); // no row written at all

    const retry = fakeEmbedder(); // now healthy
    await embedPendingBatch({ pool, embedder: retry, model: "bge-m3" }, 100);
    expect(retry.calls).toContain("רעיל"); // still pending → retried
  });

  it("reports remaining=batchSize when the batch was full (more work to do)", async () => {
    const g = await upsertGroup(pool, { name: "SWEEP-rem", source: "import" });
    await seed(pool, g, "aaa", "sw-r1");
    await seed(pool, g, "bbb", "sw-r2");
    const r = await embedPendingBatch({ pool, embedder: fakeEmbedder(), model: "bge-m3" }, 1);
    expect(r.remaining).toBe(1); // batch of 1 was full → drain again
  });

  it("escalates to error after several consecutive all-failed batches", async () => {
    // A dead feature (Ollama down / wrong dim) must not hide as per-message warn
    // noise forever — it escalates ONCE to error so it's visible.
    const g = await upsertGroup(pool, { name: "SWEEP-dead", source: "import" });
    for (let i = 0; i < 6; i++) await seed(pool, g, `dead msg ${i}`, `sw-dead-${i}`);
    const embedder: Embedder = {
      embed: async () => {
        throw new Error("ollama down");
      },
    };
    const error = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error };

    const { startEmbeddingSweep } = await import("./embedding-sweep.js");
    const handle = startEmbeddingSweep(
      { pool, embedder, model: "bge-m3", log },
      { intervalMs: 15, batchSize: 2 },
    );
    // Poll until it escalates (or time out), then stop.
    for (let i = 0; i < 40 && error.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    handle.stop();
    expect(error).toHaveBeenCalled(); // escalated, not just warned
  });
});
