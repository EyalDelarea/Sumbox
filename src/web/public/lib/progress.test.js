/**
 * Tests for progress.js — run with: npx vitest run src/web/public/lib/progress.test.js
 */
import { describe, it, expect } from "vitest";
import { loaderProgress } from "./progress.js";

describe("loaderProgress", () => {
  it("is 0 at the very start", () => {
    expect(loaderProgress(0)).toBe(0);
  });

  it("is 0 for negative / invalid elapsed", () => {
    expect(loaderProgress(-5)).toBe(0);
    expect(loaderProgress(NaN)).toBe(0);
    expect(loaderProgress(Infinity)).toBe(0);
    expect(loaderProgress(undefined)).toBe(0);
  });

  it("is positive as soon as time passes", () => {
    expect(loaderProgress(1)).toBeGreaterThan(0);
  });

  // The whole point: the bar must feel like it's MAKING PROGRESS — strictly
  // increasing second over second, never stalling or going backwards.
  it("increases monotonically with elapsed time", () => {
    let prev = -1;
    for (let t = 0; t <= 120; t++) {
      const p = loaderProgress(t);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("never reaches or exceeds the ceiling (no false 100%)", () => {
    for (const t of [10, 30, 60, 120, 600, 100000]) {
      expect(loaderProgress(t)).toBeLessThan(95);
    }
  });

  it("climbs fast early then slows (ease-out shape)", () => {
    const firstChunk = loaderProgress(10) - loaderProgress(0);
    const laterChunk = loaderProgress(60) - loaderProgress(50);
    expect(firstChunk).toBeGreaterThan(laterChunk);
  });

  it("is well past halfway by ~20s and high by ~40s (feels responsive)", () => {
    expect(loaderProgress(20)).toBeGreaterThan(50);
    expect(loaderProgress(40)).toBeGreaterThan(80);
  });

  it("honours a custom ceiling", () => {
    for (const t of [10, 60, 600]) {
      expect(loaderProgress(t, { ceiling: 80 })).toBeLessThan(80);
    }
  });
});
