/**
 * Unit tests for heartbeat.ts — uses vitest fake timers and a spy-based fake
 * pool so no real database is required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordHeartbeatFn } from "./heartbeat.js";
import { startHeartbeat } from "./heartbeat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool() {
  // Minimal pool stub — not used directly but passed through
  return {} as import("pg").Pool;
}

/**
 * Flush the microtask / promise queue.
 * Used after `startHeartbeat` to let the initial `void record(...)` settle.
 */
async function flushPromises() {
  // Schedule a microtask that resolves after all currently-queued microtasks
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests: startHeartbeat
// ---------------------------------------------------------------------------

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires one immediate heartbeat on start", async () => {
    const recordHeartbeat = vi.fn().mockResolvedValue(undefined) as RecordHeartbeatFn;
    const pool = makePool();

    startHeartbeat({ pool, intervalMs: 5000, recordHeartbeat });

    // Flush the microtask queue for the immediate async call
    await flushPromises();

    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(recordHeartbeat).toHaveBeenCalledWith(pool);
  });

  it("fires additional heartbeats on each interval tick", async () => {
    const recordHeartbeat = vi.fn().mockResolvedValue(undefined) as RecordHeartbeatFn;
    const pool = makePool();

    startHeartbeat({ pool, intervalMs: 5000, recordHeartbeat });

    // Immediate tick
    await flushPromises();
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);

    // Advance one interval
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(recordHeartbeat).toHaveBeenCalledTimes(2);

    // Advance another interval
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(recordHeartbeat).toHaveBeenCalledTimes(3);
  });

  it("stop() halts further heartbeats", async () => {
    const recordHeartbeat = vi.fn().mockResolvedValue(undefined) as RecordHeartbeatFn;
    const pool = makePool();

    const { stop } = startHeartbeat({ pool, intervalMs: 5000, recordHeartbeat });

    // Immediate tick
    await flushPromises();
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);

    // Stop before any interval fires
    stop();

    // Advance well past the interval — no more calls
    await vi.advanceTimersByTimeAsync(20000);
    await flushPromises();
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
  });
});
