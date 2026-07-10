import { describe, expect, it } from "vitest";
import { timestampToMs } from "./timestamp.js";

describe("timestampToMs", () => {
  it("converts a numeric seconds timestamp to milliseconds", () => {
    expect(timestampToMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("converts a Long-like object via toNumber()", () => {
    const long = { toNumber: () => 1_700_000_000 };
    expect(timestampToMs(long)).toBe(1_700_000_000_000);
  });

  it("coerces a numeric string via Number()", () => {
    expect(timestampToMs("1700000000")).toBe(1_700_000_000_000);
  });

  it("falls back to a recent now() for null/undefined", () => {
    const before = Date.now();
    const nullResult = timestampToMs(null);
    const undefinedResult = timestampToMs(undefined);
    const after = Date.now();
    expect(nullResult).toBeGreaterThanOrEqual(before);
    expect(nullResult).toBeLessThanOrEqual(after);
    expect(undefinedResult).toBeGreaterThanOrEqual(before);
    expect(undefinedResult).toBeLessThanOrEqual(after);
  });
});
