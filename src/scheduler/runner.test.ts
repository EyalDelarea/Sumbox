/**
 * T026 — Tests for startScheduler (runner.ts).
 *
 * All dependencies are injected — no DB, no RabbitMQ, no real timers.
 *
 * Scenarios:
 * 1. disabled → stop() is a no-op, no catch-up or timer is scheduled.
 * 2. Missed slot (dueSumbox=true on startup) → exactly one catch-up enqueue.
 * 3. Restart with updated lastRun (dueSumbox=false) → no catch-up enqueue.
 * 4. Scheduled timer fires → enqueueScheduledRun called + recordRun called + reschedule.
 * 5. stop() clears the pending timer (no further fires).
 */

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { JobBus } from "../jobs/job-bus.js";
import { startScheduler } from "./runner.js";
import type { TimeSlot } from "./schedule.js";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

function makeFakePool(): pg.Pool {
  return {} as unknown as pg.Pool;
}

function makeFakeBus(): JobBus {
  return {
    enqueue: vi.fn().mockResolvedValue({ id: "x" }),
    consume: vi.fn(),
    depth: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobBus;
}

type TimerCallback = () => void;

/**
 * Synchronous fake timer: captures callback + delay, lets tests fire it manually.
 */
function makeFakeTimer(): {
  setTimer: (cb: TimerCallback, ms: number) => NodeJS.Timeout;
  fire: () => void;
  lastMs: () => number | undefined;
  callCount: () => number;
  clearHandle: NodeJS.Timeout | null;
} {
  let cb: TimerCallback | null = null;
  let lastMs: number | undefined;
  let callCount = 0;
  let handle: NodeJS.Timeout | null = null;

  return {
    setTimer: (callback: TimerCallback, ms: number) => {
      cb = callback;
      lastMs = ms;
      callCount++;
      handle = {} as NodeJS.Timeout; // fake handle
      return handle;
    },
    fire: () => {
      if (cb) {
        cb();
      }
    },
    lastMs: () => lastMs,
    callCount: () => callCount,
    get clearHandle() {
      return handle;
    },
  };
}

const TIMES: TimeSlot[] = [
  { h: 8, m: 0 },
  { h: 18, m: 0 },
];

// Fixed "now" for tests: 09:00 on 2026-06-04 (one slot already passed today: 08:00)
const NOW_AFTER_FIRST_SLOT = new Date(2026, 5, 4, 9, 0, 0); // 09:00
const NOW_BEFORE_ALL_SLOTS = new Date(2026, 5, 4, 7, 0, 0); // 07:00

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startScheduler — disabled", () => {
  it("returns a stop() that does nothing when disabled", () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();
    const getLastRun = vi.fn();
    const recordRun = vi.fn();
    const enqueue = vi.fn();

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: false,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    stop();

    expect(timer.callCount()).toBe(0);
    expect(getLastRun).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("startScheduler — startup catch-up", () => {
  it("enqueues a catch-up run when a slot was missed (lastRun before the slot)", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    // lastRun was 07:00; 08:00 slot passed → catch-up due
    const lastRun = new Date(2026, 5, 4, 7, 0, 0);
    const getLastRun = vi.fn().mockResolvedValue(lastRun);
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue({ enqueued: 3, skipped: 0 });

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    // Give startup async work a chance to run
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 2000 });

    expect(enqueue).toHaveBeenCalledOnce();
    // recordRun is called once per slot key (TIMES has 2 slots)
    expect(recordRun).toHaveBeenCalledTimes(TIMES.length);

    stop();
  });

  it("does NOT enqueue catch-up when lastRun is after the most recent slot", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    // lastRun = 08:30 (after 08:00 slot); now=09:00; no slot in (08:30, 09:00]
    const lastRun = new Date(2026, 5, 4, 8, 30, 0);
    const getLastRun = vi.fn().mockResolvedValue(lastRun);
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue({ enqueued: 0, skipped: 0 });

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    // Wait briefly; should NOT call enqueue
    await new Promise((r) => setTimeout(r, 50));

    // Timer should still be scheduled (for the next slot), but enqueue not called
    expect(enqueue).not.toHaveBeenCalled();

    stop();
  });

  it("does NOT record slots when the enqueue fails (a failed enqueue must not advance the watermark)", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    // lastRun null → catch-up due, but enqueue rejects.
    const getLastRun = vi.fn().mockResolvedValue(null);
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockRejectedValue(new Error("enqueue boom"));

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
      logger: { info: () => {}, error: () => {} },
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 2000 });
    // The enqueue threw, so the watermark must NOT advance.
    expect(recordRun).not.toHaveBeenCalled();

    stop();
  });

  it("enqueues catch-up when lastRun is null (first ever start)", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    const getLastRun = vi.fn().mockResolvedValue(null);
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue({ enqueued: 2, skipped: 0 });

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 2000 });

    expect(enqueue).toHaveBeenCalledOnce();
    // recordRun is called once per slot key (TIMES has 2 slots)
    expect(recordRun).toHaveBeenCalledTimes(TIMES.length);

    stop();
  });
});

describe("startScheduler — slotKeyPrefix", () => {
  it("uses 'ops' prefix in state keys when slotKeyPrefix is 'ops'", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    const recordedKeys: string[] = [];
    const getLastRun = vi.fn().mockImplementation((_pool: pg.Pool, key: string) => {
      recordedKeys.push(key);
      return Promise.resolve(null);
    });
    const recordRun = vi.fn().mockImplementation((_pool: pg.Pool, key: string) => {
      recordedKeys.push(key);
      return Promise.resolve(undefined);
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
      slotKeyPrefix: "ops",
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 2000 });

    // All recorded state keys must start with "ops@"
    const allKeys = recordedKeys;
    expect(allKeys.length).toBeGreaterThan(0);
    for (const key of allKeys) {
      expect(key).toMatch(/^ops@\d{2}:\d{2}$/);
    }

    stop();
  });

  it("defaults to 'digest' prefix when slotKeyPrefix is not specified", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    const recordedKeys: string[] = [];
    const getLastRun = vi.fn().mockImplementation((_pool: pg.Pool, key: string) => {
      recordedKeys.push(key);
      return Promise.resolve(null);
    });
    const recordRun = vi.fn().mockImplementation((_pool: pg.Pool, key: string) => {
      recordedKeys.push(key);
      return Promise.resolve(undefined);
    });
    const enqueue = vi.fn().mockResolvedValue({ enqueued: 1, skipped: 0 });

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 2000 });

    const allKeys = recordedKeys;
    expect(allKeys.length).toBeGreaterThan(0);
    for (const key of allKeys) {
      expect(key).toMatch(/^digest@\d{2}:\d{2}$/);
    }

    stop();
  });
});

describe("startScheduler — scheduled timer fire", () => {
  it("fires enqueueRun + recordRun + reschedules when timer fires", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    // No missed slots (now before first slot → no catch-up)
    const getLastRun = vi.fn().mockResolvedValue(new Date(2026, 5, 4, 7, 0, 0));
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue({ enqueued: 1, skipped: 0 });

    startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_BEFORE_ALL_SLOTS, // 07:00 → no catch-up (no slot in (07:00, 07:00])
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    // Timer should have been scheduled (for 08:00)
    await vi.waitFor(() => expect(timer.callCount()).toBeGreaterThanOrEqual(1), { timeout: 2000 });

    const countBefore = timer.callCount();

    // Simulate the timer firing
    timer.fire();

    // enqueueRun and recordRun should have been called
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled(), { timeout: 2000 });
    await vi.waitFor(() => expect(timer.callCount()).toBeGreaterThan(countBefore), {
      timeout: 2000,
    });

    expect(enqueue).toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalled();
    // Timer was rescheduled
    expect(timer.callCount()).toBeGreaterThan(countBefore);
  });

  it("stop() prevents timer from running (no further enqueue calls)", async () => {
    const pool = makeFakePool();
    const bus = makeFakeBus();
    const timer = makeFakeTimer();

    const getLastRun = vi.fn().mockResolvedValue(new Date(2026, 5, 4, 8, 30, 0));
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue({ enqueued: 1, skipped: 0 });

    const { stop } = startScheduler({
      pool,
      bus,
      times: TIMES,
      enabled: true,
      now: () => NOW_AFTER_FIRST_SLOT,
      setTimer: timer.setTimer,
      getLastRun,
      recordRun,
      enqueueRun: enqueue,
    });

    await vi.waitFor(() => expect(timer.callCount()).toBeGreaterThanOrEqual(1), { timeout: 2000 });

    stop();

    // After stop, firing the timer should not call enqueue
    timer.fire();
    await new Promise((r) => setTimeout(r, 30));

    expect(enqueue).not.toHaveBeenCalled();
  });
});
