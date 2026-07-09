import { describe, expect, it } from "vitest";
import { icon } from "./icons.js";

describe("icon", () => {
  it("renders a well-formed svg for a known glyph", () => {
    const svg = icon("moon");
    expect(svg).toMatch(/^<svg class="ic" /);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("honors size and extra class", () => {
    const svg = icon("sun", { size: 28, cls: "spin" });
    expect(svg).toContain('class="ic spin"');
    expect(svg).toContain('width="28"');
  });

  it("returns empty string for an unknown glyph", () => {
    expect(icon("nope")).toBe("");
  });

  // Regression: the commands tab (callout + פקודות nav) references icon("send"),
  // which was missing from the registry and silently rendered nothing.
  it("defines the send glyph used by the commands surface", () => {
    expect(icon("send")).toMatch(/^<svg /);
  });
});
