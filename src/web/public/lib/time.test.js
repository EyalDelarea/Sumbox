/**
 * Tests for time.js — run with: npx vitest run src/web/public/lib/time.test.js
 *
 * Fixed reference point: 2026-06-02T12:00:00Z (noon UTC)
 */
import { describe, it, expect } from "vitest";
import { formatAgo, presetToSince, validateRangeInput } from "./time.js";

const NOW = Date.parse("2026-06-02T12:00:00Z"); // 1748865600000

// ─── formatAgo ────────────────────────────────────────────────────────────────

describe("formatAgo", () => {
  it("returns null for null", () => {
    expect(formatAgo(null, NOW)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(formatAgo(undefined, NOW)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(formatAgo("", NOW)).toBeNull();
  });

  it("returns null for an invalid date string", () => {
    expect(formatAgo("not-a-date", NOW)).toBeNull();
  });

  it("returns null for a future timestamp", () => {
    const future = new Date(NOW + 60_000).toISOString(); // 1 minute ahead
    expect(formatAgo(future, NOW)).toBeNull();
  });

  it('returns "ממש עכשיו" for 0 seconds ago', () => {
    const iso = new Date(NOW).toISOString();
    expect(formatAgo(iso, NOW)).toBe("ממש עכשיו");
  });

  it('returns "ממש עכשיו" for 30 seconds ago', () => {
    const iso = new Date(NOW - 30_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("ממש עכשיו");
  });

  it('returns "ממש עכשיו" for 59 seconds ago', () => {
    const iso = new Date(NOW - 59_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("ממש עכשיו");
  });

  it('returns "לפני 5 דק׳" for 5 minutes ago', () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 5 דק׳");
  });

  it('returns "לפני 1 דק׳" for exactly 1 minute ago', () => {
    const iso = new Date(NOW - 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 1 דק׳");
  });

  it('returns "לפני 59 דק׳" for 59 minutes ago', () => {
    const iso = new Date(NOW - 59 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 59 דק׳");
  });

  it('returns "לפני שעה" for exactly 1 hour ago', () => {
    const iso = new Date(NOW - 60 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני שעה");
  });

  it('returns "לפני 2 שעות" for 2 hours ago', () => {
    const iso = new Date(NOW - 2 * 60 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 2 שעות");
  });

  it('returns "לפני 23 שעות" for 23 hours ago', () => {
    const iso = new Date(NOW - 23 * 60 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 23 שעות");
  });

  it('returns "אתמול" for exactly 1 day ago', () => {
    const iso = new Date(NOW - 24 * 60 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("אתמול");
  });

  it('returns "לפני 3 ימים" for 3 days ago', () => {
    const iso = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 3 ימים");
  });

  it('returns "לפני 30 ימים" for 30 days ago', () => {
    const iso = new Date(NOW - 30 * 24 * 60 * 60_000).toISOString();
    expect(formatAgo(iso, NOW)).toBe("לפני 30 ימים");
  });
});

// ─── presetToSince ────────────────────────────────────────────────────────────

describe("presetToSince", () => {
  it("24h preset is exactly 24h before now", () => {
    const result = presetToSince("24h", NOW);
    const diff = NOW - Date.parse(result);
    expect(diff).toBe(24 * 60 * 60 * 1000);
  });

  it("3d preset is exactly 3 days before now", () => {
    const result = presetToSince("3d", NOW);
    const diff = NOW - Date.parse(result);
    expect(diff).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("week preset is exactly 7 days before now", () => {
    const result = presetToSince("week", NOW);
    const diff = NOW - Date.parse(result);
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("month preset is exactly 30 days before now", () => {
    const result = presetToSince("month", NOW);
    const diff = NOW - Date.parse(result);
    expect(diff).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("returns a valid ISO string for 24h", () => {
    const result = presetToSince("24h", NOW);
    expect(typeof result).toBe("string");
    expect(Number.isNaN(Date.parse(result))).toBe(false);
  });

  it("throws or returns null for unknown preset", () => {
    // The implementation documents that unknown preset → throws or returns null.
    // We accept either behavior.
    let result;
    try {
      result = presetToSince("unknown", NOW);
    } catch {
      result = "threw";
    }
    expect(result === null || result === "threw").toBe(true);
  });
});

// ─── validateRangeInput ───────────────────────────────────────────────────────

describe("validateRangeInput — mode: last", () => {
  it("accepts a valid positive integer n", () => {
    const r = validateRangeInput({ mode: "last", n: 50 });
    expect(r).toEqual({ ok: true, last: 50 });
  });

  it("accepts n=1", () => {
    const r = validateRangeInput({ mode: "last", n: 1 });
    expect(r.ok).toBe(true);
    expect(r.last).toBe(1);
  });

  it("rejects n=0", () => {
    const r = validateRangeInput({ mode: "last", n: 0 });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("rejects negative n", () => {
    const r = validateRangeInput({ mode: "last", n: -5 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer n (float)", () => {
    const r = validateRangeInput({ mode: "last", n: 3.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects missing n (undefined)", () => {
    const r = validateRangeInput({ mode: "last", n: undefined });
    expect(r.ok).toBe(false);
  });

  it("rejects string n", () => {
    const r = validateRangeInput({ mode: "last", n: "10" });
    expect(r.ok).toBe(false);
  });

  it("error message is a non-empty string (Hebrew expected)", () => {
    const r = validateRangeInput({ mode: "last", n: 0 });
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });
});

describe("validateRangeInput — mode: since", () => {
  // A datetime in the past relative to NOW
  const PAST_ISO = "2026-06-01T12:00:00Z"; // 1 day before NOW

  it("accepts a valid past ISO datetime", () => {
    const r = validateRangeInput({ mode: "since", datetime: PAST_ISO }, NOW);
    expect(r.ok).toBe(true);
    expect(typeof r.since).toBe("string");
    // Must be a valid ISO string
    expect(Number.isNaN(Date.parse(r.since))).toBe(false);
  });

  it("normalizes datetime to ISO string", () => {
    const r = validateRangeInput({ mode: "since", datetime: PAST_ISO }, NOW);
    expect(r.since).toBe(new Date(PAST_ISO).toISOString());
  });

  it("rejects empty string datetime", () => {
    const r = validateRangeInput({ mode: "since", datetime: "" }, NOW);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("rejects undefined datetime", () => {
    const r = validateRangeInput({ mode: "since", datetime: undefined }, NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects future datetime", () => {
    const future = new Date(NOW + 60 * 60 * 1000).toISOString();
    const r = validateRangeInput({ mode: "since", datetime: future }, NOW);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("rejects an invalid date string", () => {
    const r = validateRangeInput({ mode: "since", datetime: "not-a-date" }, NOW);
    expect(r.ok).toBe(false);
  });

  it("accepts a datetime-local format (no Z)", () => {
    // datetime-local: "2026-06-01T10:00" — parseable by Date
    const r = validateRangeInput({ mode: "since", datetime: "2026-06-01T10:00" }, NOW);
    expect(r.ok).toBe(true);
  });
});

describe("validateRangeInput — mode: sumbox", () => {
  it("always returns ok:true with no extra fields required", () => {
    const r = validateRangeInput({ mode: "sumbox" });
    expect(r).toEqual({ ok: true });
  });

  it("ignores any extra fields", () => {
    const r = validateRangeInput({ mode: "sumbox", n: 99, datetime: "whatever" });
    expect(r.ok).toBe(true);
  });
});
