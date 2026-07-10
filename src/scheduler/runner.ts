/**
 * T016 + T025 — Scheduler runner.
 *
 * startScheduler wires together the pure time math (schedule.ts),
 * the DB state (getLastRun / recordRun), and the enqueue function.
 *
 * Startup catch-up (T025): on start, for each slot, if dueSumbox() is true,
 * run enqueueRun + recordRun once. A subsequent restart with an updated lastRun
 * will return false and skip the catch-up.
 *
 * Periodic fire: after catch-up, schedule a timer to the next slot; on fire,
 * run enqueueRun + recordRun, then reschedule.
 *
 * now and setTimer are injected for full testability.
 * Never throws — errors are logged to stderr.
 */

import type pg from "pg";
import type { JobBus } from "../jobs/job-bus.js";
import type { EnqueueScheduledRunOpts } from "./enqueue-run.js";
import type { TimeSlot } from "./schedule.js";
import { dueSumbox, nextRun } from "./schedule.js";

export type StartSchedulerOpts = {
  pool: pg.Pool;
  bus: JobBus;
  times: TimeSlot[];
  enabled: boolean;
  /** Injected clock — never call Date.now() directly. */
  now: () => Date;
  /** Injected timer — mirrors setTimeout(cb, ms). */
  setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Injected DB read — returns last run for a slot key, or null. */
  getLastRun: (pool: pg.Pool, slotKey: string) => Promise<Date | null>;
  /** Injected DB write — records that a slot ran at a given time. */
  recordRun: (pool: pg.Pool, slotKey: string, runAt: Date) => Promise<void>;
  /**
   * Injected enqueue function. Return type is `unknown` so non-digest callers
   * (e.g. the ops-sweep adapter) can return void — the runner already ignores
   * the return value.
   */
  enqueueRun: (pool: pg.Pool, bus: JobBus, opts?: EnqueueScheduledRunOpts) => Promise<unknown>;
  logger?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  /**
   * Prefix used in scheduler_state slot keys, e.g. "digest" → "digest@08:00".
   * Defaults to "digest" for backward compatibility.
   */
  slotKeyPrefix?: string;
};

/**
 * Stable slot key for a time slot, e.g. "digest@08:00" or "ops@08:00".
 */
function slotKey(slot: TimeSlot, prefix: string): string {
  const hh = String(slot.h).padStart(2, "0");
  const mm = String(slot.m).padStart(2, "0");
  return `${prefix}@${hh}:${mm}`;
}

/** On the first ever run there is no prior watermark; bound the window to 12h. */
const TWELVE_H_MS = 12 * 60 * 60 * 1000;

export type SchedulerHandle = {
  stop: () => void;
};

/**
 * Start the scheduler. Returns a handle with stop() for graceful shutdown.
 *
 * If !enabled, returns a no-op stop() immediately.
 */
export function startScheduler(opts: StartSchedulerOpts): SchedulerHandle {
  const {
    pool,
    bus,
    times,
    enabled,
    now,
    setTimer,
    getLastRun,
    recordRun,
    enqueueRun,
    logger,
    slotKeyPrefix = "digest",
  } = opts;

  if (!enabled || times.length === 0) {
    return { stop: () => {} };
  }

  let stopped = false;
  let currentTimer: NodeJS.Timeout | null = null;

  const log = {
    info: (msg: string) => {
      if (logger) {
        logger.info(msg);
      }
    },
    error: (msg: string) => {
      if (logger) {
        logger.error(msg);
      } else {
        process.stderr.write(`[scheduler] ${msg}\n`);
      }
    },
  };

  /**
   * Roll up the most-recent last-run across all slots into the total-summary
   * window. Returns the window start (`sinceForTotal` — the latest last-run, or
   * `at` − 12h on the first run) and the raw `latest` (which the startup path
   * feeds to its `dueSumbox` check). Per-slot read errors are logged and skipped.
   */
  async function rollupWindow(at: Date): Promise<{ sinceForTotal: Date; latest: Date | null }> {
    let latest: Date | null = null;
    for (const slot of times) {
      const key = slotKey(slot, slotKeyPrefix);
      try {
        const lr = await getLastRun(pool, key);
        if (lr !== null && (latest === null || lr > latest)) {
          latest = lr;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`getLastRun for ${key} failed: ${msg}`);
      }
    }
    return { sinceForTotal: latest ?? new Date(at.getTime() - TWELVE_H_MS), latest };
  }

  /**
   * Record that every slot ran at `at`. Called only AFTER a successful enqueue,
   * so a failed enqueue never advances the watermark. Per-slot write errors are
   * logged and skipped.
   */
  async function recordAllSlots(at: Date): Promise<void> {
    for (const slot of times) {
      const key = slotKey(slot, slotKeyPrefix);
      try {
        await recordRun(pool, key, at);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`recordRun for ${key} failed: ${msg}`);
      }
    }
  }

  /**
   * Schedule a timer to the next slot from the given reference time.
   */
  function scheduleNext(reference: Date): void {
    if (stopped) return;

    const next = nextRun(reference, times);
    const delayMs = Math.max(0, next.getTime() - reference.getTime());

    currentTimer = setTimer(async () => {
      if (stopped) return;
      const firedAt = now();
      try {
        // The timer firing IS the due-check for the periodic path — enqueue the
        // total-summary run over the window since the previous run, then record
        // that every slot ran at firedAt.
        const { sinceForTotal } = await rollupWindow(firedAt);
        await enqueueRun(pool, bus, { sinceForTotal });
        await recordAllSlots(firedAt);
        log.info(`Scheduled run complete at ${firedAt.toISOString()}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Scheduled run failed: ${msg}`);
      }

      // Reschedule for the next slot
      if (!stopped) {
        scheduleNext(now());
      }
    }, delayMs);
  }

  /**
   * Startup catch-up: if any slot became due while the process was down, run the
   * digest exactly once. We roll up the latest last-run across all slots and let
   * `dueSumbox` decide against the combined times list — this enqueues at most
   * once no matter how many slots were missed. On the first ever start there is
   * no watermark (latest = null → dueSumbox = true), and the window falls back to
   * the last 12h so the first digest is non-empty but bounded.
   */
  async function runStartupSumbox(): Promise<void> {
    if (stopped) return;

    const nowDate = now();

    try {
      const { sinceForTotal, latest } = await rollupWindow(nowDate);
      if (dueSumbox(nowDate, latest, times)) {
        if (stopped) return;
        log.info(`Startup catch-up: running enqueueScheduledRun`);
        await enqueueRun(pool, bus, { sinceForTotal });
        await recordAllSlots(nowDate);
        log.info(`Startup catch-up complete at ${nowDate.toISOString()}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Startup catch-up failed: ${msg}`);
    }

    // Schedule the next periodic fire regardless of catch-up outcome.
    scheduleNext(now());
  }

  // Kick off startup catch-up asynchronously — errors are caught inside.
  void runStartupSumbox();

  return {
    stop: () => {
      stopped = true;
      if (currentTimer !== null) {
        clearTimeout(currentTimer);
        currentTimer = null;
      }
    },
  };
}
