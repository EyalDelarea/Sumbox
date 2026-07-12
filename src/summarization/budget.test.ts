import { describe, expect, it } from "vitest";
import { effectiveTokenBudget, RESERVED_OUTPUT_TOKENS } from "./budget.js";

describe("effectiveTokenBudget", () => {
  it("never lets the prompt claim the whole context window", () => {
    // The bug this exists to kill: num_ctx is SHARED between prompt and response.
    // A 32,342-token prompt against a 32,768 window left the model 426 tokens to
    // write in — and it stopped with done_reason 'length', mid-sentence.
    const budget = effectiveTokenBudget({ numCtx: 32768, configured: 999_999 });
    expect(budget).toBeLessThan(32768 - RESERVED_OUTPUT_TOKENS);
  });

  it("leaves room for a complete summary even at the ceiling", () => {
    const numCtx = 32768;
    const budget = effectiveTokenBudget({ numCtx, configured: 999_999 });
    // Worst case the estimate under-counts by the estimator's error margin; even
    // then the real prompt must still leave RESERVED_OUTPUT_TOKENS to generate into.
    const worstCaseRealPrompt = budget * 1.15;
    expect(numCtx - worstCaseRealPrompt).toBeGreaterThanOrEqual(RESERVED_OUTPUT_TOKENS);
  });

  it("honours a configured budget tighter than the ceiling", () => {
    // The tighter budget is a SPEED choice: prompt-eval dominates runtime
    // (~89% of a slow run), so a smaller prompt is the only lever on latency.
    expect(effectiveTokenBudget({ numCtx: 32768, configured: 12000 })).toBe(12000);
  });

  it("clamps a configured budget that would overflow the window", () => {
    // Someone setting SUMMARY_TOKEN_BUDGET=30000 against a 32k window is asking
    // for a truncated summary. The ceiling wins.
    const budget = effectiveTokenBudget({ numCtx: 32768, configured: 30000 });
    expect(budget).toBeLessThan(30000);
  });

  it("scales with the context window rather than hard-coding 32k", () => {
    const small = effectiveTokenBudget({ numCtx: 8192, configured: 999_999 });
    const large = effectiveTokenBudget({ numCtx: 65536, configured: 999_999 });
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("never returns a negative or zero budget on a tiny window", () => {
    // A pathological num_ctx must not produce a negative budget that would make
    // every selection 'too large' and strand every group forever.
    expect(effectiveTokenBudget({ numCtx: 1024, configured: 999_999 })).toBeGreaterThan(0);
  });
});
