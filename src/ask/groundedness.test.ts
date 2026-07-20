import { describe, expect, it } from "vitest";
import { extractNumerals, ungroundedNumerals } from "./groundedness.js";

describe("groundedness", () => {
  describe("extractNumerals", () => {
    it("(a) extracts numerals with length >= 2, excluding single digits", () => {
      const result = extractNumerals("נפגשים ב-19:30 ביום 3");
      expect(result).toEqual(new Set(["19", "30"]));
    });
  });

  describe("ungroundedNumerals", () => {
    it("(b) returns ungrounded numerals in lexicographic sort order", () => {
      const result = ungroundedNumerals("התוצאה 102:99", "דיברו על כדורסל");
      expect(result).toEqual(["102", "99"]);
    });

    it("(c) returns empty array when numerals are present in context", () => {
      const result = ungroundedNumerals("הסכום 42", "זה יקר 42 שקל");
      expect(result).toEqual([]);
    });

    it("(d) numerals inside a timestamp in context ground the same numeral in answer", () => {
      const result = ungroundedNumerals("פגישה ב-19", "התכנים ב-19:30");
      expect(result).toEqual([]);
    });

    it("(e) empty answer returns empty array", () => {
      const result = ungroundedNumerals("", "כל מיני טקסט 99 כאן");
      expect(result).toEqual([]);
    });
  });
});
