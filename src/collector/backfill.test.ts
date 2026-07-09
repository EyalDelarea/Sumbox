/**
 * Integration tests for backfill.ts (T008 — test-first).
 *
 * Uses Testcontainers PostgreSQL. Reuses fake WAMessage factories from collector.test.ts
 * (inline here to avoid cross-test-file coupling).
 *
 * Seed strategy:
 * - upsertGroupByWhatsappId creates a group with whatsapp_id.
 * - Seed an anchor message by calling handleIncomingMessage with one real WAMessage
 *   so getNewestAnchor returns non-null.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertGroupByWhatsappId } from "../db/repositories/groups.js";
import { createTestDatabase } from "../test/db.js";
import { backfillGroup } from "./backfill.js";
import { handleIncomingMessage } from "./collector.js";

// ---------------------------------------------------------------------------
// Fake Baileys message factories (inline copy — keep in sync with collector.test.ts)
// ---------------------------------------------------------------------------

function makeFakeWATextMessage(
  overrides: Partial<{
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant: string;
    pushName: string;
    timestampSeconds: number;
    text: string;
  }> = {},
): WAMessage {
  const {
    id = "BF_TEXT_001",
    remoteJid = "backfill-group@g.us",
    fromMe = false,
    pushName = "BackfillSender",
    timestampSeconds = 1700001000,
    text = "Backfill text message",
  } = overrides;

  return {
    key: { id, remoteJid, fromMe },
    messageTimestamp: timestampSeconds,
    pushName,
    message: { conversation: text },
  } as unknown as WAMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake WAMessage batch for awaitHistory injection. */
function makeBatch(
  count: number,
  remoteJid: string,
  baseTimestampSeconds: number,
  idPrefix: string,
): WAMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeFakeWATextMessage({
      id: `${idPrefix}-${i}`,
      remoteJid,
      timestampSeconds: baseTimestampSeconds - i * 10, // progressively older
      text: `Backfill message ${idPrefix}-${i}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("backfillGroup integration", () => {
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-backfill-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  // -------------------------------------------------------------------------
  // already-satisfied: held >= targetWindow → no fetches
  // -------------------------------------------------------------------------
  it("already-satisfied: skips fetch when held >= targetWindow", async () => {
    const remoteJid = "bf-satisfied@g.us";
    const targetWindow = 3;

    // Seed targetWindow messages (all readable text messages with external_ids)
    for (let i = 0; i < targetWindow; i++) {
      await handleIncomingMessage(
        pool,
        makeFakeWATextMessage({
          id: `SAT-MSG-${i}`,
          remoteJid,
          timestampSeconds: 1700100000 + i,
          text: `Satisfied msg ${i}`,
        }),
        { dataDir },
      );
    }

    // Get groupId via query
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    const fetchHistorySpy = vi.fn(async () => "req-id");
    const awaitHistorySpy = vi.fn(async () => []);

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow,
      maxFetch: 200,
      timeoutMs: 10_000,
      fetchHistory: fetchHistorySpy,
      awaitHistory: awaitHistorySpy,
    });

    expect(fetchHistorySpy).not.toHaveBeenCalled();
    expect(awaitHistorySpy).not.toHaveBeenCalled();
    expect(result.fetched).toBe(0);
    expect(result.partial).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // zero-anchor: group exists but no external_id message → partial:true, no fetch
  // -------------------------------------------------------------------------
  it("zero-anchor: returns partial:true when group has no anchor message", async () => {
    const remoteJid = "bf-no-anchor@g.us";

    // Create group with whatsapp_id but do NOT insert any message
    const groupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: remoteJid,
      name: remoteJid,
      source: "live",
    });

    const fetchHistorySpy = vi.fn(async () => "req-id");
    const awaitHistorySpy = vi.fn(async () => []);

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 5,
      maxFetch: 200,
      timeoutMs: 10_000,
      fetchHistory: fetchHistorySpy,
      awaitHistory: awaitHistorySpy,
    });

    expect(fetchHistorySpy).not.toHaveBeenCalled();
    expect(awaitHistorySpy).not.toHaveBeenCalled();
    expect(result.fetched).toBe(0);
    expect(result.partial).toBe(true);
  });

  // -------------------------------------------------------------------------
  // happy pagination: 2 batches until held >= targetWindow; anchor advances
  // -------------------------------------------------------------------------
  it("happy pagination: fetches 2 batches and advances anchor", async () => {
    const remoteJid = "bf-paginate@g.us";
    const anchorTs = 1700200000;

    // Seed one anchor message
    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "PAGI-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Anchor message",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    const targetWindow = 4; // need 3 more after the 1 anchor we have

    // batch1: 2 messages older than anchor (timestamps < anchorTs)
    const batch1 = makeBatch(2, remoteJid, anchorTs - 100, "PAGI-B1");
    // batch2: 2 messages even older (timestamps < batch1 oldest)
    const oldestBatch1Ts = anchorTs - 100 - (batch1.length - 1) * 10;
    const batch2 = makeBatch(2, remoteJid, oldestBatch1Ts - 100, "PAGI-B2");

    const capturedFetchCalls: Array<{
      anchor: { remoteJid: string; id: string; fromMe: boolean };
      anchorTsMs: number;
    }> = [];
    let callCount = 0;

    const fetchHistory = vi.fn(
      async (
        _count: number,
        anchor: { remoteJid: string; id: string; fromMe: boolean },
        anchorTsMs: number,
      ) => {
        capturedFetchCalls.push({ anchor, anchorTsMs });
        return "req-id";
      },
    );

    const awaitHistory = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return batch1;
      if (callCount === 2) return batch2;
      return [];
    });

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow,
      maxFetch: 200,
      timeoutMs: 10_000,
      fetchHistory,
      awaitHistory,
    });

    // Should have fetched in 2 calls
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    // Anchor should have advanced: 2nd call anchor id should differ from 1st
    expect(capturedFetchCalls[0]!.anchor.id).toBe("PAGI-ANCHOR");
    // 2nd anchor should be oldest of batch1
    const oldestBatch1 = batch1.reduce((oldest, m) => {
      const ots = typeof m.messageTimestamp === "number" ? m.messageTimestamp : 0;
      const os2 = typeof oldest.messageTimestamp === "number" ? oldest.messageTimestamp : 0;
      return ots < os2 ? m : oldest;
    });
    expect(capturedFetchCalls[1]!.anchor.id).toBe(oldestBatch1.key!.id);

    // Messages were persisted; partial false since we hit targetWindow
    expect(result.fetched).toBeGreaterThanOrEqual(targetWindow - 1); // 3 new inserts
    expect(result.partial).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify messages actually in DB
    const { rows: msgRows } = await pool.query(
      `SELECT external_id FROM messages WHERE group_id = $1 ORDER BY sent_at DESC`,
      [groupId],
    );
    const ids = msgRows.map((r: { external_id: string }) => r.external_id);
    expect(ids).toContain("PAGI-ANCHOR");
    for (const m of batch1) {
      expect(ids).toContain(m.key!.id);
    }
  });

  // -------------------------------------------------------------------------
  // dedup: already-stored message in batch is not double-counted
  // -------------------------------------------------------------------------
  it("dedup: already-stored messages in batch are not double-counted", async () => {
    const remoteJid = "bf-dedup@g.us";
    const anchorTs = 1700300000;

    // Seed anchor
    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "DEDUP-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Dedup anchor",
      }),
      { dataDir },
    );

    // Also pre-seed one message that will appear in the batch
    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "DEDUP-EXISTING",
        remoteJid,
        timestampSeconds: anchorTs - 50,
        text: "Existing message",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    // Batch includes the pre-seeded message + one new one
    const batchWithDupe: WAMessage[] = [
      makeFakeWATextMessage({
        id: "DEDUP-EXISTING", // already stored
        remoteJid,
        timestampSeconds: anchorTs - 50,
        text: "Existing message",
      }),
      makeFakeWATextMessage({
        id: "DEDUP-NEW",
        remoteJid,
        timestampSeconds: anchorTs - 100,
        text: "New message",
      }),
    ];

    let batchCallCount = 0;
    const awaitHistory = vi.fn(async () => {
      batchCallCount++;
      if (batchCallCount === 1) return batchWithDupe;
      return [];
    });

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 10, // high so we don't stop early
      maxFetch: 200,
      timeoutMs: 10_000,
      fetchHistory: vi.fn(async () => "req-id"),
      awaitHistory,
    });

    // Only 1 new insert (DEDUP-NEW), not 2
    expect(result.fetched).toBe(1);

    // DB should have exactly 1 row for DEDUP-EXISTING
    const { rows: dupeRows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages WHERE external_id = $1`,
      ["DEDUP-EXISTING"],
    );
    expect(Number(dupeRows[0]!.cnt)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // maxFetch cap: loop stops when totalFetched >= maxFetch
  // -------------------------------------------------------------------------
  it("maxFetch cap: stops loop and returns partial:true when maxFetch reached", async () => {
    const remoteJid = "bf-maxfetch@g.us";
    const anchorTs = 1700400000;

    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "MAXFETCH-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "MaxFetch anchor",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    // maxFetch = 2, targetWindow = 10 → loop stops after 2 fetched
    const maxFetch = 2;
    let batchCallCount = 0;
    const awaitHistory = vi.fn(async () => {
      batchCallCount++;
      return makeBatch(2, remoteJid, anchorTs - batchCallCount * 100, `MAXF-B${batchCallCount}`);
    });

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 10,
      maxFetch,
      timeoutMs: 10_000,
      fetchHistory: vi.fn(async () => "req-id"),
      awaitHistory,
    });

    expect(result.fetched).toBeLessThanOrEqual(maxFetch);
    expect(result.partial).toBe(true);
  });

  // -------------------------------------------------------------------------
  // timeoutMs: loop stops when clock passes the deadline
  // -------------------------------------------------------------------------
  it("timeoutMs: stops loop and returns partial:true when clock exceeds timeout", async () => {
    const remoteJid = "bf-timeout@g.us";
    const anchorTs = 1700500000;

    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "TIMEOUT-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Timeout anchor",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    // Simulate time already expired by making now() always return past the deadline
    let nowCalls = 0;
    const start = 1_000_000;
    const timeoutMs = 100;
    const now = vi.fn(() => {
      nowCalls++;
      // First call (in step 1 before loop or early): return start.
      // After the first batch completes, report past timeout so loop stops.
      if (nowCalls <= 2) return start;
      return start + timeoutMs + 1; // past deadline
    });

    let batchCallCount = 0;
    const awaitHistory = vi.fn(async () => {
      batchCallCount++;
      return makeBatch(1, remoteJid, anchorTs - batchCallCount * 10, `TO-B${batchCallCount}`);
    });

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 20,
      maxFetch: 200,
      timeoutMs,
      fetchHistory: vi.fn(async () => "req-id"),
      awaitHistory,
      now,
    });

    // Loop must have stopped — not all 20 messages fetched
    expect(result.partial).toBe(true);
    expect(awaitHistory.mock.calls.length).toBeLessThan(20);
  });

  // -------------------------------------------------------------------------
  // empty batch → stop (partial:true)
  // -------------------------------------------------------------------------
  it("empty batch: stops immediately and returns partial:true", async () => {
    const remoteJid = "bf-empty-batch@g.us";
    const anchorTs = 1700600000;

    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "EMPTY-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Empty batch anchor",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    const fetchHistorySpy = vi.fn(async () => "req-id");
    const awaitHistorySpy = vi.fn(async () => [] as WAMessage[]);

    const result = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 5,
      maxFetch: 200,
      timeoutMs: 10_000,
      fetchHistory: fetchHistorySpy,
      awaitHistory: awaitHistorySpy,
    });

    // Called once (to try), got empty → stopped
    expect(fetchHistorySpy).toHaveBeenCalledTimes(1);
    expect(awaitHistorySpy).toHaveBeenCalledTimes(1);
    expect(result.fetched).toBe(0);
    expect(result.partial).toBe(true);
  });

  // -------------------------------------------------------------------------
  // never throws: fetchHistory/awaitHistory reject → partial:true, no throw
  // -------------------------------------------------------------------------
  it("never throws: fetch rejection → partial:true without throwing", async () => {
    const remoteJid = "bf-never-throw@g.us";
    const anchorTs = 1700700000;

    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "NOTHROW-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Never throw anchor",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    const rejectingFetch = vi.fn(async () => {
      throw new Error("fetchHistory boom");
    });

    await expect(
      backfillGroup({
        pool,
        groupId,
        dataDir,
        targetWindow: 5,
        maxFetch: 200,
        timeoutMs: 10_000,
        fetchHistory: rejectingFetch,
        awaitHistory: vi.fn(async () => []),
      }),
    ).resolves.toMatchObject({ partial: true, fetched: 0 });
  });

  it("never throws: awaitHistory rejection → partial:true without throwing", async () => {
    const remoteJid = "bf-never-throw-await@g.us";
    const anchorTs = 1700800000;

    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "NOTHROW2-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Never throw2 anchor",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    const rejectingAwait = vi.fn(async () => {
      throw new Error("awaitHistory boom");
    });

    await expect(
      backfillGroup({
        pool,
        groupId,
        dataDir,
        targetWindow: 5,
        maxFetch: 200,
        timeoutMs: 10_000,
        fetchHistory: vi.fn(async () => "req-id"),
        awaitHistory: rejectingAwait,
      }),
    ).resolves.toMatchObject({ partial: true, fetched: 0 });
  });

  // -------------------------------------------------------------------------
  // gap-mode: stop on timestamp boundary, not the count target
  // -------------------------------------------------------------------------
  it("gap-mode: pages backward until a batch crosses stopAtSentAt", async () => {
    const remoteJid = "bf-gap@g.us";
    const topTs = 1700300000;

    // Seed the "top" anchor (getNewestAnchor starts here).
    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({ id: "GAP-TOP", remoteJid, timestampSeconds: topTs, text: "top" }),
      { dataDir },
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    // stop 500s below the top. Batches walk older; the 3rd crosses the line.
    const batch1 = [
      makeFakeWATextMessage({
        id: "GAP-B1-0",
        remoteJid,
        timestampSeconds: topTs - 100,
        text: "b1-0",
      }),
      makeFakeWATextMessage({
        id: "GAP-B1-1",
        remoteJid,
        timestampSeconds: topTs - 200,
        text: "b1-1",
      }),
    ];
    const batch2 = [
      makeFakeWATextMessage({
        id: "GAP-B2-0",
        remoteJid,
        timestampSeconds: topTs - 400,
        text: "b2-0",
      }),
    ];
    const batch3 = [
      // topTs-600 is below the stop (topTs-500) → loop should stop after this batch.
      makeFakeWATextMessage({
        id: "GAP-B3-0",
        remoteJid,
        timestampSeconds: topTs - 600,
        text: "b3-0",
      }),
    ];
    const pages = [batch1, batch2, batch3];
    let call = 0;
    const fetchHistory = vi.fn(async () => "req");
    const awaitHistory = vi.fn(async () => pages[call++] ?? []);

    const res = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 25, // would normally keep going to 25 held; gap-mode must ignore it
      maxFetch: 200,
      timeoutMs: 10_000,
      stopAtSentAt: new Date((topTs - 500) * 1000),
      fetchHistory,
      awaitHistory,
    });

    expect(awaitHistory).toHaveBeenCalledTimes(3); // stopped right after crossing the boundary
    expect(res.fetched).toBe(4); // 900,800,600,400-equivalents all newly inserted
    expect(res.partial).toBe(false); // reached the stop boundary
  });

  // -------------------------------------------------------------------------
  // persistMediaDescriptor: spy receives descriptor for backfilled image message
  // -------------------------------------------------------------------------
  it("persistMediaDescriptor: spy called once with kind 'image' for backfilled image message", async () => {
    const remoteJid = "bf-media-descriptor@g.us";
    const anchorTs = 1700900000;

    // Seed an anchor message so getNewestAnchor returns non-null
    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({
        id: "MEDIA-DESC-ANCHOR",
        remoteJid,
        timestampSeconds: anchorTs,
        text: "Anchor for media descriptor test",
      }),
      { dataDir },
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    // Build a fake image WAMessage (older than anchor so it passes as history)
    const imageMessage = {
      key: {
        id: "MEDIA-DESC-IMG-001",
        remoteJid,
        fromMe: false,
      },
      messageTimestamp: anchorTs - 100,
      pushName: "ImageSender",
      message: {
        imageMessage: {
          mediaKey: new Uint8Array([1, 2, 3, 4]),
          directPath: "/v/t62.7118-24/test-path",
          url: "https://mmg.whatsapp.net/test",
          mimetype: "image/jpeg",
        },
      },
    } as unknown as WAMessage;

    const persistMediaDescriptorSpy = vi.fn(async () => {});

    let batchCallCount = 0;
    const awaitHistory = vi.fn(async () => {
      batchCallCount++;
      if (batchCallCount === 1) return [imageMessage];
      return [] as WAMessage[];
    });

    await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 5,
      maxFetch: 200,
      timeoutMs: 10_000,
      fetchHistory: vi.fn(async () => "req-id"),
      awaitHistory,
      persistMediaDescriptor: persistMediaDescriptorSpy,
    });

    expect(persistMediaDescriptorSpy).toHaveBeenCalledTimes(1);
    const [, descriptor] = persistMediaDescriptorSpy.mock.calls[0]!;
    expect(descriptor.mediaKind).toBe("image");
  });

  it("gap-mode: returns partial:true when maxFetch is hit before crossing stopAtSentAt", async () => {
    const remoteJid = "bf-gap-cap@g.us";
    const topTs = 1700400000;

    await handleIncomingMessage(
      pool,
      makeFakeWATextMessage({ id: "GAPCAP-TOP", remoteJid, timestampSeconds: topTs, text: "top" }),
      { dataDir },
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1`,
      [remoteJid],
    );
    const groupId = Number(rows[0]!.id);

    let i = 0;
    const fetchHistory = vi.fn(async () => "req");
    // Every batch stays above the stop → never crosses; maxFetch must cap it.
    const awaitHistory = vi.fn(async () => [
      makeFakeWATextMessage({
        id: `GAPCAP-${i++}`,
        remoteJid,
        timestampSeconds: topTs - 100,
        text: "above",
      }),
    ]);

    const res = await backfillGroup({
      pool,
      groupId,
      dataDir,
      targetWindow: 25,
      maxFetch: 2,
      timeoutMs: 10_000,
      stopAtSentAt: new Date((topTs - 1000) * 1000),
      fetchHistory,
      awaitHistory,
    });

    expect(res.partial).toBe(true);
    expect(res.fetched).toBeLessThanOrEqual(2);
  });
});
