/**
 * repeat.test.ts — the verdict rules, pinned.
 *
 * Each test maps to a real mistake this module exists to prevent, so a future
 * change that makes the harness more confident fails here loudly.
 */
import { describe, expect, it } from "vitest";
import { type Comparison, compare, formatComparison, summarize } from "./repeat.js";

describe("summarize", () => {
  it("reports the observed range, not just the mean", () => {
    // A mean alone is what let a 0.13/0.25/0.50 spread read as a single score.
    const s = summarize([{ refused: 0.5 }, { refused: 0.1 }, { refused: 0.3 }]);
    expect(s[0]).toMatchObject({ metric: "refused", min: 0.1, max: 0.5, runs: 3 });
    expect(s[0]!.mean).toBeCloseTo(0.3);
    expect(s[0]!.spread).toBeCloseTo(0.4);
  });

  it("handles an empty arm without throwing", () => {
    expect(summarize([])).toEqual([]);
  });
});

describe("compare", () => {
  it("calls a difference smaller than the arms' own spread UNRESOLVABLE", () => {
    // The PR #78 mistake, exactly: an apparent improvement well inside the noise.
    const before = [{ refused: 0.5 }, { refused: 0.1 }, { refused: 0.3 }];
    const after = [{ refused: 0.4 }, { refused: 0.1 }, { refused: 0.2 }];
    const [r] = compare(before, after);
    expect(r!.verdict).toBe("unresolvable");
    // And it must NOT be reported as "no change" — the distinction is the point.
    expect(r!.delta).not.toBe(0);
  });

  it("calls a difference larger than the noise MOVED", () => {
    const before = [{ refused: 0.9 }, { refused: 0.85 }, { refused: 0.88 }];
    const after = [{ refused: 0.1 }, { refused: 0.12 }, { refused: 0.09 }];
    expect(compare(before, after)[0]!.verdict).toBe("moved");
  });

  it("refuses to call a single-run comparison, however large the gap", () => {
    // One sample has no observed spread, so it cannot clear a bar it never
    // measured. This is the guard that makes the original error unrepeatable.
    const [r] = compare([{ refused: 1 }], [{ refused: 0 }]);
    expect(r!.verdict).toBe("unresolvable");
  });

  it("reports flat only when there is genuinely nothing to see", () => {
    const [r] = compare([{ hebrew: 1 }, { hebrew: 1 }], [{ hebrew: 1 }, { hebrew: 1 }]);
    expect(r!.verdict).toBe("flat");
  });

  it("skips metrics missing from one arm rather than scoring them zero", () => {
    // A metric added between arms must not read as a collapse from 1 to 0.
    const rows = compare(
      [
        { a: 1, b: 1 },
        { a: 1, b: 1 },
      ],
      [{ a: 1 }, { a: 1 }],
    );
    expect(rows.map((r) => r.metric)).toEqual(["a"]);
  });
});

describe("formatComparison", () => {
  const row = (over: Partial<Comparison>): Comparison =>
    ({
      metric: "refused",
      before: { metric: "refused", mean: 0.8, min: 0.8, max: 0.8, spread: 0, runs: 3 },
      after: { metric: "refused", mean: 0.2, min: 0.2, max: 0.2, spread: 0, runs: 3 },
      delta: -0.6,
      noise: 0,
      verdict: "moved",
      ...over,
    }) as Comparison;

  it("reads a fall in a lower-is-better metric as an improvement", () => {
    // Without the direction marker, "-0.600" on `refused` invites being read as
    // a regression by whoever skims the table next month.
    const out = formatComparison([row({})], new Set(["refused"]));
    expect(out).toContain("better");
    expect(out).not.toContain("worse");
  });

  it("reads a fall in a higher-is-better metric as a regression", () => {
    const out = formatComparison([row({ metric: "hebrew" })], new Set(["refused"]));
    expect(out).toContain("worse");
  });

  it("says plainly that unresolvable is not 'no change'", () => {
    const out = formatComparison([row({ verdict: "unresolvable", noise: 0.4 })], new Set());
    expect(out).toContain("cannot tell");
  });
});
