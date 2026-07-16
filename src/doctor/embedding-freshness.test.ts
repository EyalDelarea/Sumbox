import { describe, expect, it } from "vitest";
import { describeFreshness, type FreshnessProbe, isFresh } from "./embedding-freshness.js";

const p = (over: Partial<FreshnessProbe> = {}): FreshnessProbe => ({
  pending: 0,
  oldestPendingMs: null,
  ...over,
});

describe("isFresh", () => {
  it("is healthy when the queue is drained", () => {
    expect(isFresh(p())).toBe(true);
  });

  it("is healthy while a backlog is young", () => {
    expect(isFresh(p({ pending: 5000, oldestPendingMs: 60_000 }))).toBe(true);
  });

  it("is UNHEALTHY when one message has been stuck too long", () => {
    // Age, not volume: a huge backlog draining fast is fine; a single message
    // stuck for an hour means the sweep is dead. This is the 2026-07-16 outage.
    expect(isFresh(p({ pending: 1, oldestPendingMs: 60 * 60_000 }))).toBe(false);
  });

  it("is healthy exactly at the threshold", () => {
    expect(isFresh(p({ pending: 1, oldestPendingMs: 5 * 60_000 }))).toBe(true);
  });
});

describe("describeFreshness", () => {
  it("says so plainly when drained", () => {
    expect(describeFreshness(p())).toMatch(/all messages embedded/);
  });

  it("names the consequence, not just the number", () => {
    // The point of the check is that a stale sweep makes her LIE, and the
    // outage was invisible precisely because nothing said so.
    const d = describeFreshness(p({ pending: 42, oldestPendingMs: 50 * 60_000 }));
    expect(d).toContain("42 message(s) unembedded");
    expect(d).toContain("50 min");
    expect(d).toContain("לא מצאתי");
  });
});
