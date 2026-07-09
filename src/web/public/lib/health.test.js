/**
 * Tests for health.js — run with: npx vitest run src/web/public/lib/health.test.js
 */
import { describe, it, expect } from "vitest";
import { deriveHealth } from "./health.js";

const healthyLiveness = { healthy: true, lastHeartbeatAt: "2026-06-04T06:43:22Z" };

describe("deriveHealth", () => {
  it("is healthy when the collector is alive (liveness.healthy = true)", () => {
    expect(deriveHealth({ liveness: healthyLiveness })).toBe(true);
  });

  // Regression: a dead/failed BACKGROUND job must NOT make the system read as
  // "not responding". This is the bug that flipped the banner to
  // "המערכת לא מגיבה — הפעילו מחדש לסנכרון" because of one stale analyze.image job.
  it("stays healthy when the collector is alive but a background job is dead", () => {
    const status = {
      liveness: healthyLiveness,
      service: { collectorConnected: true, stale: false },
      jobs: { pending: 83, running: 0, done: 124, failed: 0, dead: 1 },
    };
    expect(deriveHealth(status)).toBe(true);
  });

  it("stays healthy when the collector is alive but jobs have failed", () => {
    const status = {
      liveness: healthyLiveness,
      jobs: { failed: 3, dead: 0 },
    };
    expect(deriveHealth(status)).toBe(true);
  });

  it("is unhealthy when liveness reports the collector down", () => {
    expect(deriveHealth({ liveness: { healthy: false } })).toBe(false);
  });

  it("falls back to service flags when liveness is absent", () => {
    expect(
      deriveHealth({ service: { collectorConnected: true, stale: false } }),
    ).toBe(true);
  });

  it("is unhealthy when the collector is connected but stale (no liveness)", () => {
    expect(
      deriveHealth({ service: { collectorConnected: true, stale: true } }),
    ).toBe(false);
  });

  it("is unhealthy when the collector is disconnected (no liveness)", () => {
    expect(
      deriveHealth({ service: { collectorConnected: false, stale: false } }),
    ).toBe(false);
  });

  it("is unhealthy for a malformed/empty payload", () => {
    expect(deriveHealth({})).toBe(false);
    expect(deriveHealth(null)).toBe(false);
  });
});
