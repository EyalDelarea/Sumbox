import { describe, expect, it } from "vitest";
import { buildTotalPrompt } from "./total-prompt.js";

describe("buildTotalPrompt", () => {
  it("includes each chat name as a labeled section in the user prompt", () => {
    const prompt = buildTotalPrompt([
      { groupId: 1, name: "Work", messageCount: 12, summary: "## תקציר\nתקציב" },
      { groupId: 2, name: "Family", messageCount: 5, summary: "## תקציר\nשבת" },
    ]);
    expect(prompt.user).toContain("[Work]");
    expect(prompt.user).toContain("[Family]");
    expect(prompt.user).toContain("תקציב");
    // System prompt instructs cross-cutting attention extraction in Hebrew.
    expect(prompt.system).toContain("דורש תשומת לב");
  });

  it("tags each highlight bullet with its source chat (instruction present)", () => {
    const prompt = buildTotalPrompt([{ groupId: 1, name: "Work", messageCount: 1, summary: "x" }]);
    expect(prompt.system).toContain("[");
  });
});
