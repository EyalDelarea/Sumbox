/**
 * retention-sweep.ts — periodic, per-tenant enforcement of the unselected-chat retention
 * window. For every tenant that has opted in (user_preferences.retention_days set), delete
 * their unselected chats with no activity in the last N days, then unlink the freed media.
 *
 * This is the cross-tenant fix for the old media-purge loop, which only ran for the default
 * tenant. Runs on the operator (BYPASSRLS) pool; `purgeUnselectedChats` is tenant-bounded by
 * the selected group ids, so isolation holds. A tenant that has not set retention is never
 * touched (the zero-config default), so single-user behavior is unchanged unless opted in.
 *
 * Mirrors media-purge-loop: injected deps, no-overlap guard, per-tenant failure isolation.
 */

export type RetentionLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type RetentionSweepDeps = {
  /** Tenants that opted into retention, with their window (operator-pool read). */
  listTenants: () => Promise<Array<{ tenantId: string; retentionDays: number }>>;
  /** Delete a tenant's dormant unselected chats; returns affected count + freed media paths. */
  purgeChats: (
    tenantId: string,
    olderThanDays: number,
  ) => Promise<{ chatsAffected: number; mediaPaths: string[] }>;
  /** Unlink freed media files (best-effort), run AFTER the purge commits. */
  unlink: (paths: readonly string[]) => Promise<number>;
  log?: RetentionLog;
};

/** Sweep every opted-in tenant once. Returns the total number of chats purged. */
export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<number> {
  const tenants = await deps.listTenants();
  let totalChats = 0;

  for (const { tenantId, retentionDays } of tenants) {
    try {
      const { chatsAffected, mediaPaths } = await deps.purgeChats(tenantId, retentionDays);
      if (mediaPaths.length > 0) await deps.unlink(mediaPaths);
      totalChats += chatsAffected;
    } catch (err) {
      // One tenant's failure never aborts the sweep for the others.
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.warn(`[retention] tenant ${tenantId} sweep failed: ${msg}`);
    }
  }

  if (totalChats > 0) {
    deps.log?.info(`[retention] purged ${totalChats} unselected chat(s) across tenants`);
  }
  return totalChats;
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
