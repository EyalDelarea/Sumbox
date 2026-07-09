/**
 * liveness.test.ts — Pure unit tests for src/service/liveness.ts
 * No database needed; all time is injected via the `now` parameter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getLastHeartbeatAt, isHealthy, markHeartbeat, resetLiveness } from "./liveness.js";

describe("liveness", () => {
  beforeEach(() => {
    resetLiveness();
  });

  it("returns null for getLastHeartbeatAt before any heartbeat", () => {
    expect(getLastHeartbeatAt()).toBeNull();
  });

  it("isHealthy returns false when no heartbeat has been recorded", () => {
    expect(isHealthy(60_000)).toBe(false);
  });

  it("isHealthy returns true immediately after markHeartbeat within threshold", () => {
    const now = Date.now();
    markHeartbeat(now);
    // Check 1ms later — still within 60s threshold
    expect(isHealthy(60_000, now + 1)).toBe(true);
  });

  it("getLastHeartbeatAt returns the time passed to markHeartbeat", () => {
    const ts = 1_700_000_000_000;
    markHeartbeat(ts);
    expect(getLastHeartbeatAt()).toBe(ts);
  });

  it("isHealthy returns false when now is well past the threshold", () => {
    const beatAt = 1_000_000;
    markHeartbeat(beatAt);
    // now = beatAt + threshold + 1ms → stale
    const staleNow = beatAt + 60_000 + 1;
    expect(isHealthy(60_000, staleNow)).toBe(false);
  });

  it("isHealthy returns true when now is exactly at the threshold boundary", () => {
    const beatAt = 1_000_000;
    markHeartbeat(beatAt);
    // now = beatAt + threshold → exactly at edge → still healthy (within, not past)
    expect(isHealthy(60_000, beatAt + 60_000)).toBe(true);
  });

  it("resetLiveness clears the last heartbeat so isHealthy becomes false again", () => {
    const now = Date.now();
    markHeartbeat(now);
    expect(isHealthy(60_000, now + 1)).toBe(true);
    resetLiveness();
    expect(getLastHeartbeatAt()).toBeNull();
    expect(isHealthy(60_000, now + 1)).toBe(false);
  });

  it("markHeartbeat uses Date.now() when no argument is provided", () => {
    const before = Date.now();
    markHeartbeat();
    const after = Date.now();
    const recorded = getLastHeartbeatAt();
    expect(recorded).not.toBeNull();
    expect(recorded!).toBeGreaterThanOrEqual(before);
    expect(recorded!).toBeLessThanOrEqual(after);
  });

  it("multiple calls to markHeartbeat update the stored value", () => {
    markHeartbeat(1000);
    markHeartbeat(2000);
    expect(getLastHeartbeatAt()).toBe(2000);
  });
});
