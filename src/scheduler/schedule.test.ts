/**
 * T011 + T024 — Unit tests for pure scheduler time functions.
 *
 * parseTimes, nextRun, dueSumbox — all pure, no DB, no Date.now().
 */
import { describe, expect, it } from "vitest";
import { dueSumbox, nextRun, parseTimes, resolveDigestTimes } from "./schedule.js";

describe("resolveDigestTimes", () => {
  it("uses the stored CSV when present and valid", () => {
    expect(resolveDigestTimes("07:00,20:00", "08:00,18:00")).toEqual([
      { h: 7, m: 0 },
      { h: 20, m: 0 },
    ]);
  });

  it("falls back to the env default when stored is null/empty", () => {
    expect(resolveDigestTimes(null, "08:00")).toEqual([{ h: 8, m: 0 }]);
    expect(resolveDigestTimes("  ", "08:00")).toEqual([{ h: 8, m: 0 }]);
  });

  it("falls back to the env default when stored is malformed", () => {
    expect(resolveDigestTimes("nonsense", "09:00")).toEqual([{ h: 9, m: 0 }]);
    expect(resolveDigestTimes("25:99", "09:00")).toEqual([{ h: 9, m: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// parseTimes
// ---------------------------------------------------------------------------

describe("parseTimes", () => {
  it("parses a single HH:MM slot", () => {
    const result = parseTimes("08:00");
    expect(result).toEqual([{ h: 8, m: 0 }]);
  });

  it("parses two slots and returns them sorted", () => {
    // 18:00 before 08:00 in the string, should be sorted
    const result = parseTimes("18:00,08:00");
    expect(result).toEqual([
      { h: 8, m: 0 },
      { h: 18, m: 0 },
    ]);
  });

  it("deduplicates identical slots", () => {
    const result = parseTimes("08:00,08:00");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ h: 8, m: 0 });
  });

  it("deduplicates and sorts combined", () => {
    const result = parseTimes("18:00,08:00,18:00");
    expect(result).toEqual([
      { h: 8, m: 0 },
      { h: 18, m: 0 },
    ]);
  });

  it("parses three distinct slots in sorted order", () => {
    const result = parseTimes("22:30,06:00,12:15");
    expect(result).toEqual([
      { h: 6, m: 0 },
      { h: 12, m: 15 },
      { h: 22, m: 30 },
    ]);
  });

  it("throws on non HH:MM format", () => {
    expect(() => parseTimes("8:00")).toThrow();
  });

  it("throws on hour > 23", () => {
    expect(() => parseTimes("24:00")).toThrow();
  });

  it("throws on minute > 59", () => {
    expect(() => parseTimes("08:60")).toThrow();
  });

  it("throws on non-numeric input", () => {
    expect(() => parseTimes("morning")).toThrow();
  });

  it("throws on partially valid input", () => {
    expect(() => parseTimes("08:00,bad")).toThrow();
  });

  it("trims whitespace around entries", () => {
    const result = parseTimes(" 08:00 , 18:00 ");
    expect(result).toEqual([
      { h: 8, m: 0 },
      { h: 18, m: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// nextRun
// ---------------------------------------------------------------------------

describe("nextRun", () => {
  const times = [
    { h: 8, m: 0 },
    { h: 18, m: 0 },
  ];

  it("returns the first slot today when now is before both slots", () => {
    // 07:00 today → next is 08:00 today
    const now = new Date(2026, 5, 4, 7, 0, 0); // month is 0-indexed
    const result = nextRun(now, times);
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(4);
    expect(result.getMonth()).toBe(5);
    expect(result.getFullYear()).toBe(2026);
  });

  it("returns the second slot today when now is between the two slots", () => {
    // 10:00 → next is 18:00 today
    const now = new Date(2026, 5, 4, 10, 0, 0);
    const result = nextRun(now, times);
    expect(result.getHours()).toBe(18);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(4);
  });

  it("returns tomorrow's first slot when all slots passed today", () => {
    // 20:00 → both 08:00 and 18:00 have passed → first slot tomorrow (08:00)
    const now = new Date(2026, 5, 4, 20, 0, 0);
    const result = nextRun(now, times);
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(5); // tomorrow
    expect(result.getMonth()).toBe(5);
  });

  it("returns the exact slot when now is exactly on a slot (≥ boundary)", () => {
    // now = 08:00:00 exactly → that slot counts as the next (≥ boundary)
    const now = new Date(2026, 5, 4, 8, 0, 0);
    const result = nextRun(now, times);
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(0);
    expect(result.getDate()).toBe(4);
  });

  it("wraps to tomorrow correctly when slots straddle midnight (single late slot)", () => {
    // 23:30 with a single 08:00 slot → tomorrow 08:00
    const singleSlot = [{ h: 8, m: 0 }];
    const now = new Date(2026, 5, 4, 23, 30, 0);
    const result = nextRun(now, singleSlot);
    expect(result.getDate()).toBe(5);
    expect(result.getHours()).toBe(8);
  });

  it("wraps at end of month", () => {
    // June 30, 20:00 → July 1, 08:00
    const now = new Date(2026, 5, 30, 20, 0, 0); // June 30
    const result = nextRun(now, times);
    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(6); // July (0-indexed)
    expect(result.getHours()).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// dueSumbox
// ---------------------------------------------------------------------------

describe("dueSumbox", () => {
  const times = [
    { h: 8, m: 0 },
    { h: 18, m: 0 },
  ];

  it("returns true when lastRun is null (first ever start)", () => {
    const now = new Date(2026, 5, 4, 9, 0, 0);
    expect(dueSumbox(now, null, times)).toBe(true);
  });

  it("returns true when a slot fell in (lastRun, now]", () => {
    // lastRun was at 07:00, now is 09:00 → 08:00 slot is in between
    const lastRun = new Date(2026, 5, 4, 7, 0, 0);
    const now = new Date(2026, 5, 4, 9, 0, 0);
    expect(dueSumbox(now, lastRun, times)).toBe(true);
  });

  it("returns false when no slot fell in (lastRun, now] — same day, before first slot", () => {
    // lastRun at 06:00, now at 07:30 → no slot between 06:00 and 07:30
    const lastRun = new Date(2026, 5, 4, 6, 0, 0);
    const now = new Date(2026, 5, 4, 7, 30, 0);
    expect(dueSumbox(now, lastRun, times)).toBe(false);
  });

  it("returns false when no slot fell in (lastRun, now] — ran after last slot", () => {
    // lastRun at 19:00, now at 20:00 → no slot in (19:00, 20:00]
    const lastRun = new Date(2026, 5, 4, 19, 0, 0);
    const now = new Date(2026, 5, 4, 20, 0, 0);
    expect(dueSumbox(now, lastRun, times)).toBe(false);
  });

  it("returns true when now is exactly on a slot and lastRun is before it", () => {
    // now = 08:00 exactly, lastRun = 07:00 → 08:00 is in (lastRun, now] (closed right)
    const lastRun = new Date(2026, 5, 4, 7, 0, 0);
    const now = new Date(2026, 5, 4, 8, 0, 0);
    expect(dueSumbox(now, lastRun, times)).toBe(true);
  });

  it("returns false when lastRun is exactly on a slot and now is still on it", () => {
    // lastRun = now = 08:00 → no slot in (08:00, 08:00]
    const lastRun = new Date(2026, 5, 4, 8, 0, 0);
    const now = new Date(2026, 5, 4, 8, 0, 0);
    expect(dueSumbox(now, lastRun, times)).toBe(false);
  });

  it("catches up a missed slot spanning overnight", () => {
    // machine was down: lastRun yesterday at 19:00, now is today 09:00
    // yesterday 08:00 was already covered (before lastRun), but yesterday 18:00
    // was covered too (before lastRun). Today 08:00 is in range.
    const lastRun = new Date(2026, 5, 3, 19, 0, 0); // June 3, 19:00
    const now = new Date(2026, 5, 4, 9, 0, 0); // June 4, 09:00
    expect(dueSumbox(now, lastRun, times)).toBe(true);
  });

  it("guarantees at-most-once: after recordRun the same startup returns false", () => {
    // Simulates startup catch-up then restart with updated lastRun
    const slotTime = new Date(2026, 5, 4, 8, 0, 0);
    const now = new Date(2026, 5, 4, 9, 0, 0);
    // First startup: lastRun = null → true
    expect(dueSumbox(now, null, times)).toBe(true);
    // After recording the catch-up as lastRun = slotTime or later:
    expect(dueSumbox(now, slotTime, times)).toBe(false);
  });

  it("returns false when lastRun exactly matches now and no slot between", () => {
    const t = new Date(2026, 5, 4, 10, 0, 0);
    expect(dueSumbox(t, t, times)).toBe(false);
  });
});
