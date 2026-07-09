/**
 * media-purge-loop.ts — periodic sweep that minimizes (deletes bytes, keeps
 * descriptor) for media belonging to chats the user has NOT included, once they
 * have been present longer than the configured grace window.
 *
 * Mirrors media-backfill-loop.ts in structure: injected deps, no-overlap guard,
 * per-item failure isolation, best-effort unlink before state update.
 */

import type { MinimizableMedia } from "../db/repositories/message-media.js";

export type PurgeLog = {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type PurgeDeps = {
  selectMinimizable: (olderThanMs: number) => Promise<MinimizableMedia[]>;
  unlinkFile: (filePath: string) => Promise<void>;
  markMinimized: (messageId: number) => Promise<void>;
  log?: PurgeLog;
};

/** Minimize one batch of eligible rows. Returns the count minimized. */
export async function runPurgeBatch(deps: PurgeDeps, olderThanMs: number): Promise<number> {
  const rows = await deps.selectMinimizable(olderThanMs);
  let done = 0;

  for (const row of rows) {
    try {
      // Delete the bytes first (best-effort: ENOENT is fine — file already gone).
      if (row.mediaPath) {
        await deps.unlinkFile(row.mediaPath);
      }
      // Flip state + null the file pointer.
      await deps.markMinimized(row.messageId);
      done++;
    } catch (err) {
      // Per-item failures never abort the batch.
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.warn(`[media-purge] message ${row.messageId} minimize failed: ${msg}`);
    }
  }

  if (done > 0) {
    deps.log?.info(`[media-purge] minimized ${done} media file(s)`);
  }

  return done;
}

export type PurgeLoopHandle = { stop: () => void };

/**
 * Start a polling loop that runs `runPurgeBatch` every `intervalMs`, with a
 * no-overlap guard so sweeps never pile up. Mirrors `startBackfillLoop`.
 */
export function startMediaPurgeLoop(
  deps: PurgeDeps,
  opts: { intervalMs: number; olderThanMs: number },
): PurgeLoopHandle {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runPurgeBatch(deps, opts.olderThanMs);
    } catch (err) {
      if (!stopped) {
        deps.log?.warn(
          `[media-purge] batch error: ${err instanceof Error ? err.message : String(err)}`,
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
