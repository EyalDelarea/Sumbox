/**
 * reconnect-recovery.ts — on boot/reconnect, recover messages missed during an
 * outage.
 *
 * The missed messages are not lost: they live on the user's phone. WhatsApp's
 * passive reconnect channels (append / messaging-history.set, see session.ts)
 * deliver the recent window and raise the newest-stored message; this orchestrator
 * also actively extends each active group's history backward (gap-mode backfill)
 * down to the message we already had BEFORE the outage.
 *
 * Two things the caller must get right (see cli.ts):
 *  - The `tLast` in each snapshot is captured BEFORE the session connects, so it
 *    reflects the pre-outage state. The active backfill anchors at the *current*
 *    newest (raised by the passive sync) and pages back to this frozen `tLast` —
 *    if they were read at the same time they'd be equal and nothing would fetch.
 *  - Gating (heartbeat staleness) happens in the caller; this only runs when given
 *    a snapshot to recover.
 *
 * Recovery is measured as "readable messages now newer than the pre-outage
 * snapshot" — counting whatever came back via EITHER channel (passive or active),
 * which is the ground-truth signal.
 *
 * Pure and fully testable via injected dependencies — no real Baileys/DB.
 */

/** Per-group pre-outage snapshot, captured before the session connects. */
export type GroupSnapshot = {
  id: number;
  name: string;
  /** Newest stored message timestamp before the outage, or null if none stored. */
  tLast: Date | null;
};

export type ReconnectRecoveryDeps = {
  /** Active groups + their pre-outage newest-message timestamps (captured before connect). */
  snapshots: GroupSnapshot[];
  /** Active backfill: page a group's history backward down to stopAtSentAt. Must not throw. */
  gapFill: (
    groupId: number,
    stopAtSentAt: Date,
  ) => Promise<{ fetched: number; durationMs: number; partial: boolean }>;
  /** Count readable messages in a group strictly newer than `since` (the recovery signal). */
  countReadableSince: (groupId: number, since: Date) => Promise<number>;
  /** Optional structured logger (pino-shaped). */
  logger?: { info: (obj: unknown, msg: string) => void };
};

export type ReconnectRecoveryResult = { groups: number; recovered: number };

/**
 * Recover messages missed during downtime. Returns how many groups were considered
 * and how many messages (across both channels) are now newer than the pre-outage
 * snapshot. Never throws — a single group's failure is logged and skipped.
 */
export async function recoverOnReconnect(
  deps: ReconnectRecoveryDeps,
): Promise<ReconnectRecoveryResult> {
  let recovered = 0;

  for (const g of deps.snapshots) {
    try {
      // Active extend: only meaningful when something was stored before (a lower
      // bound) and the passive sync has since raised the newest above it.
      if (g.tLast !== null) {
        await deps.gapFill(g.id, g.tLast);
      }

      // Ground-truth measurement: everything now newer than the pre-outage newest,
      // regardless of which channel delivered it (passive append/history-set or
      // active fetch). Groups with nothing stored (tLast null) use epoch 0.
      const since = g.tLast ?? new Date(0);
      const n = await deps.countReadableSince(g.id, since);
      recovered += n;

      if (n > 0) {
        deps.logger?.info(
          { evt: "reconnect-sync", group: g.name, groupId: g.id, recovered: n },
          "reconnect-sync",
        );
      }
    } catch (err) {
      deps.logger?.info(
        {
          evt: "reconnect-sync",
          group: g.name,
          groupId: g.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "reconnect-sync error",
      );
    }
  }

  return { groups: deps.snapshots.length, recovered };
}
