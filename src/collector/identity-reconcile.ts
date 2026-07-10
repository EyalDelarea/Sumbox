import type pg from "pg";
import { siblingForJid } from "../db/repositories/identity-links.js";
import { findMergeCandidates, type MergeBridge, mergeGroups } from "../db/repositories/merge.js";
import { withTransaction } from "../db/transaction.js";
import { getLogger } from "../logging/log.js";

const log = getLogger("identity-reconcile");

/**
 * Reconcile lid/phone duplicate chats using ONLY the durable identity_links map —
 * no live WhatsApp session required. Reuses the dedupe-safe mergeGroups engine.
 *
 * Each pair is merged in its OWN short transaction (not one big batch tx) so row
 * locks on groups/messages/imports release between pairs: a large first-run
 * backfill never stalls concurrent ingest writers, and two workers racing the
 * same candidate stays safe — the loser's mergeGroups simply finds the dup
 * already gone and is logged as a skip rather than corrupting anything.
 *
 * Returns the number of pairs merged.
 */
export async function reconcileIdentities(pool: pg.Pool): Promise<number> {
  // 1. Discover candidates in one short read transaction.
  const candidates = await withTransaction(pool, (client) => {
    // DB-backed bridge: same shape the live session provides, sourced from the map.
    const bridge: MergeBridge = {
      lidForPn: (pn) => siblingForJid(client, pn),
      pnForLid: (lid) => siblingForJid(client, lid),
    };
    return findMergeCandidates(client, bridge);
  });
  if (candidates.length === 0) return 0;

  // 2. Merge each pair in its own transaction so locks release between pairs.
  let merged = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      await withTransaction(pool, (client) =>
        mergeGroups(client, { survivorId: c.survivorId, dupId: c.dupId, name: c.name }),
      );
      merged++;
    } catch (err) {
      skipped++;
      log.warn(
        { survivorId: c.survivorId, dupId: c.dupId, err },
        "reconcile pair failed, skipping",
      );
    }
  }
  if (merged > 0 || skipped > 0) {
    log.info({ merged, skipped }, "identity reconcile complete");
  }
  return merged;
}
