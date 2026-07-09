import { describe, expect, it } from "vitest";
import { renderSummary } from "./render.js";

describe("renderSummary", () => {
  it("puts each sentence on its own line so RTL text renders readably", () => {
    const out = { overview: "משפט ראשון. משפט שני? משפט שלישי!" };
    const lines = renderSummary(out).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("משפט ראשון.");
    expect(lines[1]).toContain("משפט שני?");
    expect(lines[2]).toContain("משפט שלישי!");
  });

  it("marks each line right-to-left (U+200F) to fix terminal bidi direction", () => {
    const out = { overview: "סיכום קצר." };
    expect(renderSummary(out).startsWith("‏")).toBe(true);
  });

  it("returns a single line when there is one sentence", () => {
    const out = { overview: "סיכום קצר ללא סימני פיסוק" };
    expect(renderSummary(out).split("\n")).toHaveLength(1);
  });
});
