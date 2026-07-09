import { describe, expect, it } from "vitest";
import { resolveInitialTheme } from "./theme.js";

describe("resolveInitialTheme", () => {
  it("honors an explicit stored choice over the OS preference", () => {
    expect(resolveInitialTheme("light", true)).toBe("light");
    expect(resolveInitialTheme("dark", false)).toBe("dark");
  });

  it("falls back to the OS preference when nothing is stored", () => {
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(null, false)).toBe("light");
  });

  it("defaults to light for unknown stored values", () => {
    expect(resolveInitialTheme("banana", false)).toBe("light");
    expect(resolveInitialTheme("banana", true)).toBe("dark");
  });
});
