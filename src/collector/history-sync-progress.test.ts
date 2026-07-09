import { describe, expect, it, vi } from "vitest";
import { createHistorySyncProgress, type ProgressTimer } from "./history-sync-progress.js";

/** A controllable clock + timer so tests are deterministic (no real time). */
function harness() {
  let t = 1_000_000;
  const log = vi.fn<(line: string) => void>();
  let pending: { fn: () => void; at: number } | null = null;

  const setTimer = (fn: () => void, ms: number): ProgressTimer => {
    pending = { fn, at: t + ms };
    return {
      cancel() {
        pending = null;
      },
    };
  };

  return {
    log,
    advance(ms: number) {
      t += ms;
    },
    /** Fire the pending idle timer if its deadline has passed. */
    flushTimer() {
      if (pending && t >= pending.at) {
        const fn = pending.fn;
        pending = null;
        fn();
      }
    },
    progress: createHistorySyncProgress({
      log,
      throttleMs: 1000,
      idleMs: 3000,
      now: () => t,
      setTimer,
    }),
  };
}

describe("createHistorySyncProgress", () => {
  it("logs the first batch immediately as cumulative progress", () => {
    const h = harness();
    h.progress.record(50);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith("syncing… 50 message(s) received");
  });

  it("throttles rapid batches but keeps a running total", () => {
    const h = harness();
    h.progress.record(50); // logs (t=0 since last)
    h.advance(200);
    h.progress.record(50); // within throttle window → no log
    h.advance(200);
    h.progress.record(50); // still within window → no log

    expect(h.log).toHaveBeenCalledTimes(1);

    h.advance(1000); // past throttleMs since last log
    h.progress.record(50); // logs cumulative total = 200
    expect(h.log).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenLastCalledWith("syncing… 200 message(s) received");
  });

  it("emits a completion summary once batches go idle, then resets", () => {
    const h = harness();
    h.progress.record(40);
    h.progress.record(10);

    h.advance(3000); // idle period elapses
    h.flushTimer();

    expect(h.log).toHaveBeenLastCalledWith(
      "sync complete: 50 message(s) received across 2 batch(es)",
    );

    // After completion the counters reset — a new sync starts fresh.
    h.advance(5000);
    h.progress.record(7);
    expect(h.log).toHaveBeenLastCalledWith("syncing… 7 message(s) received");
  });

  it("ignores empty batches", () => {
    const h = harness();
    h.progress.record(0);
    expect(h.log).not.toHaveBeenCalled();
  });
});
