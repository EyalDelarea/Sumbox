/**
 * retention-sweep.ts — periodic enforcement of the unselected-chat retention window.
 * When retention is enabled (RETENTION_DAYS), delete unselected chats with no activity
 * in the last N days, then unlink the freed media.
 *
 * Retention is OFF by default (the zero-config default), so nothing is touched unless
 * opted in. Mirrors media-purge-loop: injected deps and a no-overlap guard.
 */

export type RetentionLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type RetentionSweepDeps = {
  /** The retention window in days, or 0 when retention is disabled. */
  retentionDays: () => Promise<number>;
  /** Delete dormant unselected chats; returns affected count + freed media paths. */
  purgeChats: (olderThanDays: number) => Promise<{ chatsAffected: number; mediaPaths: string[] }>;
  /** Unlink freed media files (best-effort), run AFTER the purge commits. */
  unlink: (paths: readonly string[]) => Promise<number>;
  log?: RetentionLog;
};

/** Run one sweep. Returns the number of chats purged. */
export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<number> {
  const retentionDays = await deps.retentionDays();
  if (retentionDays <= 0) return 0;

  try {
    const { chatsAffected, mediaPaths } = await deps.purgeChats(retentionDays);
    if (mediaPaths.length > 0) await deps.unlink(mediaPaths);
    if (chatsAffected > 0) {
      deps.log?.info(`[retention] purged ${chatsAffected} unselected chat(s)`);
    }
    return chatsAffected;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log?.warn(`[retention] sweep failed: ${msg}`);
    return 0;
  }
}

export type RetentionSweepHandle = { stop: () => void };

/**
 * Start a polling loop that runs `runRetentionSweep` every `intervalMs`, with a no-overlap
 * guard so sweeps never pile up. Mirrors `startMediaPurgeLoop`.
 */
export function startRetentionSweep(
  deps: RetentionSweepDeps,
  opts: { intervalMs: number },
): RetentionSweepHandle {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runRetentionSweep(deps);
    } catch (err) {
      if (!stopped) {
        deps.log?.warn(
          `[retention] sweep error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, opts.intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
