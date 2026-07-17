import { describe, expect, it } from "vitest";
import { parseCitedIds } from "./citations.js";

const valid = new Set([101, 102, 103]);

describe("parseCitedIds", () => {
  it("reads the cited ids", () => {
    expect(parseCitedIds("[msg:101]", valid)).toEqual([101]);
  });

  it("drops an id that was never a candidate", () => {
    // The anti-hallucination gate: we can only quote what we offered.
    expect(parseCitedIds("[msg:999]", valid)).toEqual([]);
  });

  it("keeps the valid ids when the reply mixes both", () => {
    expect(parseCitedIds("[msg:101] [msg:999] [msg:102]", valid)).toEqual([101, 102]);
  });

  it("dedupes repeats but keeps first-seen order", () => {
    // The first id is the one that gets quoted, so order is not cosmetic.
    expect(parseCitedIds("[msg:102] [msg:101] [msg:102]", valid)).toEqual([102, 101]);
  });

  describe("plural forms — the prompt asks for 'id(s)'", () => {
    // A matcher told to give "the id(s)" reasonably answers [msg:101, 102].
    // Understanding only the canonical form would report "no source" for a
    // correct match.
    it.each([
      ["[msg:101, 102]", [101, 102]],
      ["[msg:101, msg:102]", [101, 102]],
      ["[msg: 101]", [101]],
      ["[msg:101][msg:102]", [101, 102]],
      ["[MSG:101]", [101]],
    ] as const)("%s", (raw, expected) => {
      expect(parseCitedIds(raw, valid)).toEqual(expected);
    });
  });

  it.each([
    ["NONE", "the matcher's no-match reply"],
    ["", "empty"],
    ["[msg:abc]", "non-numeric"],
    ["I think it was message 101", "prose, no tag"],
  ])("returns nothing for %s (%s)", (raw) => {
    expect(parseCitedIds(raw, valid)).toEqual([]);
  });
});
