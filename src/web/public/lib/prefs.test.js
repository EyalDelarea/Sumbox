import { describe, expect, it } from "vitest";
import { DIGEST_CHOICES, isDigestSelected, parseDigestCsv, toggleDigestTime } from "./prefs.js";

describe("parseDigestCsv", () => {
  it("normalizes, sorts and dedupes valid HH:MM entries", () => {
    expect(parseDigestCsv("20:00, 08:00 ,08:00")).toEqual(["08:00", "20:00"]);
  });

  it("drops malformed and out-of-range entries", () => {
    expect(parseDigestCsv("8:00,25:00,08:99,08:30,foo")).toEqual(["08:30"]);
  });

  it("tolerates empty / nullish input", () => {
    expect(parseDigestCsv("")).toEqual([]);
    expect(parseDigestCsv(null)).toEqual([]);
    expect(parseDigestCsv(undefined)).toEqual([]);
  });
});

describe("isDigestSelected", () => {
  it("reflects membership of a choice in the CSV", () => {
    expect(isDigestSelected("08:00,20:00", "08:00")).toBe(true);
    expect(isDigestSelected("08:00,20:00", "07:00")).toBe(false);
  });
});

describe("toggleDigestTime", () => {
  it("adds a missing time and keeps the spec sorted", () => {
    expect(toggleDigestTime("08:00", "07:00")).toBe("07:00,08:00");
  });

  it("removes a present time", () => {
    expect(toggleDigestTime("08:00,20:00", "08:00")).toBe("20:00");
  });

  it("preserves non-choice times already in the CSV when toggling a choice", () => {
    // 18:00 is not a picker chip but must survive a toggle of 09:00.
    expect(toggleDigestTime("08:00,18:00", "09:00")).toBe("08:00,09:00,18:00");
  });

  it("refuses to empty the spec (so we never PUT an invalid empty CSV)", () => {
    expect(toggleDigestTime("08:00", "08:00")).toBe("08:00");
  });

  it("every default choice is a valid HH:MM the picker can round-trip", () => {
    for (const c of DIGEST_CHOICES) {
      expect(parseDigestCsv(c)).toEqual([c]);
    }
  });
});
