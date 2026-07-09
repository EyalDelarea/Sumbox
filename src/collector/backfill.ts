/**
 * backfill.ts — Pulls older history for a group and persists it.
 *
 * Pure and fully testable via injected dependencies — no real Baileys.
 * Uses handleIncomingMessage as the persistence path (DRY: map/normalize/dedupe/insert).
 *
 * T009 — implementation for backfill-orchestrator slice.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { countReadableByGroup, getNewestAnchor } from "../db/repositories/messages.js";
import type { Logger } from "../logging/logger.js";
import { handleIncomingMessage } from "./collector.js";

export type AnchorKey = { remoteJid: string; id: string; fromMe: boolean };

export type BackfillDeps = {
  pool: pg.Pool;
  groupId: number;
  dataDir: string;
  /** Target # of readable messages we want to hold for the group (e.g. 25). */
  targetWindow: number;
  /** Hard cap on total messages pulled this run (e.g. 200). */
  maxFetch: number;
  /** Overall wall-clock budget in ms (e.g. 10_000). */
  timeoutMs: number;
  /** Injected: ask WhatsApp for `count` messages older than the anchor. Returns request id. */
  fetchHistory: (count: number, anchor: AnchorKey, anchorTsMs: number) => Promise<string>;
  /** Injected: resolve with WAMessages delivered for this chat, or [] on timeout. */
  awaitHistory: (timeoutMs: number) => Promise<WAMessage[]>;
  /**
   * Gap-mode: page backward until a fetched batch's oldest message is at/below this
   * timestamp. When set, the count target (`targetWindow`) is NOT used as the stop
   * condition — used by boot-time gap recovery to fill exactly the downtime window.
   */
  stopAtSentAt?: Date;
  /** Page size for gap-mode fetch requests (default 50). Ignored in count-mode. */
  pageSize?: number;
  /** Optional: download voice note media; passed through to handleIncomingMessage. */
  downloadVoiceNote?: (m: WAMessage) => Promise<Buffer>;
  /**
   * Optional lid<->pn bridge, passed through to handleIncomingMessage so backfilled
   * history is identity-canonicalized too (issue #17). When absent, the per-message
   * `remoteJidAlt` key fallback still applies.
   */
  lidForPn?: (pn: string) => Promise<string | null>;
  pnForLid?: (lid: string) => Promise<string | null>;
  /**
   * Optional descriptor sink, passed through to handleIncomingMessage so
   * backfilled media gets a message_media row and can be deferred-downloaded
   * later (mirrors the live path). When absent, no descriptor is stored.
   */
  persistMediaDescriptor?: (
    messageId: number,
    descriptor: import("./media-descriptor.js").MediaDescriptor,
    state: "pending" | "present",
  ) => Promise<void>;
  /** Optional structured logger, passed through to handleIncomingMessage so a
   *  backfilled message's media-download/descriptor diagnostics are logged. */
  log?: Logger;
  /** Injected clock (defaults to Date.now). */
  now?: () => number;
};

export type BackfillResult = { fetched: number; durationMs: number; partial: boolean };

/**
 * Coerce a Baileys messageTimestamp (number | Long-like | null | undefined) to milliseconds.
 *
 * Baileys stores timestamps as seconds (matching message-mapper's timestampToMs approach).
 * Long-like objects (from protobufjs) expose a .toNumber() method.
 */
function timestampToMs(ts: unknown): number {
  if (ts == null) return Date.now();
  if (typeof ts === "number") return ts * 1000;
  if (typeof (ts as { toNumber?: () => number }).toNumber === "function") {
    return (ts as { toNumber: () => number }).toNumber() * 1000;
  }
  return Number(ts) * 1000;
}

/**
 * Orchestrate a backfill for a single group.
 *
 * Algorithm:
 * 1. If held >= targetWindow → already satisfied, return immediately.
 * 2. If no anchor → return partial:true (zero-anchor; no messages to page from).
 * 3. Loop: fetch pages until held >= targetWindow OR totalFetched >= maxFetch OR timeout.
 *    - advance anchor to oldest message of each batch for pagination.
 * 4. Wrap everything in try/catch — NEVER throw to the caller.
 */
export async function backfillGroup(deps: BackfillDeps): Promise<BackfillResult> {
  const {
    pool,
    groupId,
    dataDir,
    targetWindow,
    maxFetch,
    timeoutMs,
    fetchHistory,
    awaitHistory,
    downloadVoiceNote,
    lidForPn,
    pnForLid,
    persistMediaDescriptor,
    log,
    stopAtSentAt,
    pageSize = 50,
    now = Date.now,
  } = deps;

  const start = now();
  const stopMs = stopAtSentAt ? stopAtSentAt.getTime() : null;
  const gapMode = stopMs !== null;

  try {
    // --- Step 1: Check if already satisfied (count-mode only) ---
    let held = await countReadableByGroup(pool, groupId);
    if (!gapMode && held >= targetWindow) {
      return { fetched: 0, durationMs: now() - start, partial: false };
    }

    // --- Step 2: Get anchor ---
    const anchor = await getNewestAnchor(pool, groupId);
    if (!anchor) {
      return { fetched: 0, durationMs: now() - start, partial: true };
    }

    // --- Step 3: Loop ---
    let totalFetched = 0;
    let anchorKey: AnchorKey = {
      remoteJid: anchor.remoteJid,
      id: anchor.externalId,
      fromMe: anchor.fromMe,
    };
    let anchorTsMs = anchor.sentAt.getTime();

    while (
      (gapMode ? anchorTsMs > stopMs! : held < targetWindow) &&
      totalFetched < maxFetch &&
      now() - start < timeoutMs
    ) {
      const want = gapMode
        ? Math.max(1, Math.min(pageSize, maxFetch - totalFetched))
        : Math.max(1, Math.min(targetWindow - held, maxFetch - totalFetched));

      const remaining = timeoutMs - (now() - start);

      try {
        await fetchHistory(want, anchorKey, anchorTsMs);
        const batch = await awaitHistory(Math.max(0, remaining));

        if (batch.length === 0) {
          // No more history available / phone offline
          break;
        }

        // Persist each message via handleIncomingMessage (dedupe path)
        for (const m of batch) {
          const isNew = await handleIncomingMessage(pool, m, {
            dataDir,
            downloadVoiceNote,
            lidForPn,
            pnForLid,
            persistMediaDescriptor,
            log,
          });
          if (isNew) {
            totalFetched++;
          }
        }

        // Advance anchor to the OLDEST message in this batch
        // (to paginate further back on the next request)
        let oldestMsg = batch[0]!;
        let oldestTs = timestampToMs(oldestMsg.messageTimestamp);
        for (const m of batch) {
          const ts = timestampToMs(m.messageTimestamp);
          if (ts < oldestTs) {
            oldestTs = ts;
            oldestMsg = m;
          }
        }

        anchorKey = {
          remoteJid: oldestMsg.key?.remoteJid ?? anchorKey.remoteJid,
          id: oldestMsg.key?.id ?? anchorKey.id,
          fromMe: oldestMsg.key?.fromMe ?? false,
        };
        anchorTsMs = oldestTs;

        // Refresh held count from DB (reflects actual inserts via handleIncomingMessage)
        held = await countReadableByGroup(pool, groupId);
      } catch (err) {
        // Fetch/await failure: best-effort stop with partial
        process.stderr.write(
          `[backfillGroup] fetch error for groupId=${groupId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return { fetched: totalFetched, durationMs: now() - start, partial: true };
      }
    }

    const partial = gapMode ? anchorTsMs > stopMs! : held < targetWindow;
    return { fetched: totalFetched, durationMs: now() - start, partial };
  } catch (err) {
    // Outer catch: DB errors or unexpected failures — never throw to caller
    process.stderr.write(
      `[backfillGroup] unexpected error for groupId=${groupId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { fetched: 0, durationMs: now() - start, partial: true };
  }
}
