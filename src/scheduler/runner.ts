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
        // Find the most recent last-run across all slots to bound the total-summary window.
        let periodicLatestLastRun: Date | null = null;
        for (const slot of times) {
          const key = slotKey(slot, slotKeyPrefix);
          try {
            const lr = await getLastRun(pool, key);
            if (lr !== null && (periodicLatestLastRun === null || lr > periodicLatestLastRun)) {
              periodicLatestLastRun = lr;
            }
          } catch {
            // Ignore per-slot errors; fallback to 12h window below
          }
        }
        // Total summary window = since the previous scheduled run (or last 12h on first fire).
        const TWELVE_H_MS = 12 * 60 * 60 * 1000;
        const sinceForTotal = periodicLatestLastRun ?? new Date(firedAt.getTime() - TWELVE_H_MS);
        await enqueueRun(pool, bus, { sinceForTotal });
        // Record the run for the slot that just fired.
        // We record for every time slot that is <= firedAt and > their last run.
        // For simplicity (single catch-up slot per fire), record for each slot.
        for (const slot of times) {
          const key = slotKey(slot, slotKeyPrefix);
          const slotInstant = new Date(firedAt);
          slotInstant.setHours(slot.h, slot.m, 0, 0);
          // If the slot has just passed (or is very close to now), record it.
          // Use the fired-at time to avoid depending on exact math.
          try {
            await recordRun(pool, key, firedAt);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`recordRun for ${key} failed: ${msg}`);
          }
        }
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
   * Startup catch-up: check every slot; if dueSumbox() is true, run once.
   *
   * We check all slots together (using the combined times list) to avoid
   * multiple catch-up runs when several slots were missed. We use the
   * most-recently-completed slot key as the state key. A conservative
   * approach: use the first slot's key as the single catch-up key, and
   * check the overall dueSumbox across all times.
   *
   * Simpler and correct: use a single catch-up key "digest@sumbox" that
   * represents "the last time any slot ran". This avoids per-slot state
   * proliferation and matches the at-most-once guarantee.
   *
   * Actually, per the data model, we record per slot key. So check each
   * slot independently and enqueue at most once across the whole batch.
   */
  async function runStartupSumbox(): Promise<void> {
    if (stopped) return;

    const nowDate = now();

    try {
      // Find the most recent slot that has run (to drive overall dueSumbox).
      // Strategy: check if ANY slot is due, then enqueue once.
      let latestLastRun: Date | null = null;
      for (const slot of times) {
        const key = slotKey(slot, slotKeyPrefix);
        try {
          const lr = await getLastRun(pool, key);
          if (lr !== null) {
            if (latestLastRun === null || lr > latestLastRun) {
              latestLastRun = lr;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`getLastRun for ${slotKey(slot, slotKeyPrefix)} failed: ${msg}`);
        }
      }

      // If no slot has ever run, latestLastRun is null → dueSumbox = true.
      if (dueSumbox(nowDate, latestLastRun, times)) {
        if (stopped) return;
        log.info(`Startup catch-up: running enqueueScheduledRun`);
        // Total summary window = since the previous scheduled run (or last 12h
        // on first ever run, so the first digest is non-empty but bounded).
        const TWELVE_H_MS = 12 * 60 * 60 * 1000;
        const sinceForTotal = latestLastRun ?? new Date(nowDate.getTime() - TWELVE_H_MS);
        await enqueueRun(pool, bus, { sinceForTotal });

        // Record the catch-up run for all slot keys (sets their last_run_at to now)
        for (const slot of times) {
          const key = slotKey(slot, slotKeyPrefix);
          try {
            await recordRun(pool, key, nowDate);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`recordRun for ${key} failed: ${msg}`);
          }
        }
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
