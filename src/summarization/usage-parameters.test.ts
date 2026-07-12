import { describe, expect, it } from "vitest";
import type { GenUsage } from "./summarizer.js";
import { withGenUsage } from "./usage-parameters.js";

const usage: GenUsage = {
  promptTokens: 32176,
  evalTokens: 592,
  doneReason: "length",
  truncated: true,
  promptMs: 124909,
  evalMs: 23248,
};

describe("withGenUsage", () => {
  it("folds the real token counts and the timing split onto the row's parameters", () => {
    const out = withGenUsage(
      { since: "2026-07-09" },
      { genMs: 148572, usage, estimatedTokens: 14822 },
    );

    expect(out).toEqual({
      since: "2026-07-09", // preserved
      genMs: 148572,
      estimatedTokens: 14822,
      promptTokens: 32176,
      evalTokens: 592,
      promptMs: 124909,
      evalMs: 23248,
      doneReason: "length",
      truncated: true,
    });
  });

  it("keeps estimatedTokens alongside promptTokens so the chars/4 error is measurable", () => {
    // This pairing is the whole point: 32176 / 14822 = 2.17x under-count. Persisting
    // both lets the budget be calibrated on the real distribution, not one sample.
    const out = withGenUsage({}, { genMs: 1, usage, estimatedTokens: 14822 });
    expect(out["promptTokens"]).toBe(32176);
    expect(out["estimatedTokens"]).toBe(14822);
  });

  it("records genMs even when the engine reported no usage", () => {
    // A summarizer fake (or a non-Ollama engine) may never call onUsage. The row
    // must still carry the duration rather than losing it.
    const out = withGenUsage({ n: 50 }, { genMs: 999 });
    expect(out).toEqual({ n: 50, genMs: 999 });
  });

  it("does not clobber caller-supplied parameters", () => {
    const out = withGenUsage(
      { messageCount: 84, usedFallback: false },
      { genMs: 5, usage, estimatedTokens: 10 },
    );
    expect(out["messageCount"]).toBe(84);
    expect(out["usedFallback"]).toBe(false);
  });
});
