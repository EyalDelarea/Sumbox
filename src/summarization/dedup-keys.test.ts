import { describe, expect, it } from "vitest";
import { intentKey, keyOverlap, normalizeText, participantSetKey, topicKey } from "./dedup-keys.js";

describe("normalizeText", () => {
  it("lowercases, strips punctuation/niqqud, collapses whitespace", () => {
    expect(normalizeText("  Hello,   WORLD!! ")).toBe("hello world");
    // niqqud-decorated שָׁלוֹם collapses to bare שלום
    expect(normalizeText("שָׁלוֹם")).toBe("שלום");
  });

  it("returns '' for nullish/blank", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText("   ")).toBe("");
  });
});

describe("intentKey", () => {
  it("is order-independent and drops fillers + duplicates", () => {
    expect(intentKey("לשלוח לרונית מחיר")).toBe(intentKey("מחיר לרונית לשלוח"));
    // "את"/"של" are stopwords; word order and punctuation don't matter
    expect(intentKey("לשלוח את המחיר של רונית")).toBe(intentKey("המחיר רונית לשלוח"));
  });

  it("ignores case and punctuation for English too", () => {
    expect(intentKey("Send the price to Ronit!")).toBe(intentKey("ronit price send"));
  });

  it("returns '' for empty/stopword-only input", () => {
    expect(intentKey("")).toBe("");
    expect(intentKey("של את על")).toBe("");
  });
});

describe("topicKey", () => {
  it("matches intentKey normalization", () => {
    expect(topicKey("פגישת סטטוס שבועית")).toBe(intentKey("שבועית סטטוס פגישת"));
  });
});

describe("participantSetKey", () => {
  it("is order-independent, unique, and drops blanks", () => {
    expect(participantSetKey(["יוסי", "דנה"])).toBe(participantSetKey(["דנה", "יוסי"]));
    expect(participantSetKey(["דנה", "דנה", "", null, "  "])).toBe("דנה");
  });

  it("returns '' for an empty set", () => {
    expect(participantSetKey([])).toBe("");
    expect(participantSetKey([null, "  ", undefined])).toBe("");
  });
});

describe("keyOverlap", () => {
  it("is 1 for identical keys and 0 for disjoint/empty", () => {
    expect(keyOverlap("a b c", "a b c")).toBe(1);
    expect(keyOverlap("a b", "c d")).toBe(0);
    expect(keyOverlap("", "a")).toBe(0);
  });

  it("is the Jaccard ratio for partial overlap", () => {
    // {a,b,c} vs {b,c,d}: intersection 2, union 4 → 0.5
    expect(keyOverlap("a b c", "b c d")).toBe(0.5);
  });
});
