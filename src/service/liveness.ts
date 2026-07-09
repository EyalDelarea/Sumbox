/**
 * liveness.ts — In-memory collector liveness tracker.
 *
 * Holds the timestamp of the most recent heartbeat and exposes helpers to
 * check whether the process is still healthy (i.e., the heartbeat was
 * recorded within a given threshold).
 *
 * This is intentionally in-memory only (not persisted). The existing
 * `service_status` DB row remains the cross-process / `/api/status` view.
 */

let lastHeartbeatAt: number | null = null;

/**
 * Record a heartbeat at `now` ms (defaults to `Date.now()`).
 */
export function markHeartbeat(now?: number): void {
  lastHeartbeatAt = now ?? Date.now();
}

/**
 * Return the timestamp (ms) of the last recorded heartbeat, or null if none.
 */
export function getLastHeartbeatAt(): number | null {
  return lastHeartbeatAt;
}

/**
 * Return true iff the last heartbeat was recorded within `thresholdMs` of
 * `now` (defaults to `Date.now()`). Returns false if no heartbeat has been
 * recorded yet.
 */
export function isHealthy(thresholdMs: number, now?: number): boolean {
  if (lastHeartbeatAt === null) return false;
  const currentTime = now ?? Date.now();
  return currentTime - lastHeartbeatAt <= thresholdMs;
}

/**
 * Reset the liveness state. Intended for use in tests only.
 */
export function resetLiveness(): void {
  lastHeartbeatAt = null;
}
