/**
 * timestamp.ts — shared Baileys timestamp coercion for the collector.
 *
 * Pure and dependency-free (no DB, no sockets) so both the pure message mapper
 * and the backfill orchestrator can share one copy instead of keeping two
 * verbatim implementations in sync by hand.
 */

/**
 * Convert a Baileys messageTimestamp (`number | Long-like | null | undefined`)
 * to milliseconds.
 *
 * Baileys stores timestamps as seconds; Long-like objects (from protobufjs)
 * expose a `.toNumber()` method. A missing timestamp falls back to now.
 */
export function timestampToMs(ts: unknown): number {
  if (ts == null) return Date.now();
  if (typeof ts === "number") return ts * 1000;
  // Long-like objects (from protobufjs) have a toNumber() method
  if (typeof (ts as { toNumber?: () => number }).toNumber === "function") {
    return (ts as { toNumber: () => number }).toNumber() * 1000;
  }
  return Number(ts) * 1000;
}
