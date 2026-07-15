import { describe, expect, it } from "vitest";
import { rrfFuse } from "./rrf.js";

describe("rrfFuse", () => {
  it("ranks an id that both lists like above ids only one list likes", () => {
    // 7 is #2 in both lists; 1 and 4 are #1 in one list each.
    const fused = rrfFuse([
      [1, 7, 2],
      [4, 7, 9],
    ]);
    expect(fused[0]).toBe(7); // agreement wins
    expect(fused).toContain(1);
    expect(fused).toContain(4);
  });

  it("preserves order for a single list", () => {
    expect(rrfFuse([[3, 1, 2]])).toEqual([3, 1, 2]);
  });

  it("dedupes ids across lists", () => {
    const fused = rrfFuse([
      [1, 2],
      [2, 1],
    ]);
    expect([...fused].sort()).toEqual([1, 2]);
    expect(fused).toHaveLength(2);
  });

  it("rewards a higher rank more (1/(C+rank) is decreasing)", () => {
    // 5 rank0 (1/60), 8 rank1 (1/61) in list A; 6 rank0 (1/60) in list B.
    // 5 and 6 tie on score → first-seen (5) wins; 8's lower rank puts it last.
    const fused = rrfFuse([[5, 8], [6]]);
    expect(fused[0]).toBe(5);
    expect(fused[fused.length - 1]).toBe(8);
  });

  it("is empty-safe", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });
});
