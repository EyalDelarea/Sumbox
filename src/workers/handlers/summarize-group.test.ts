/**
 * T015 — Tests for makeSummarizeGroupHandler.
 *
 * Tests use injected fakes — no live DB, no Ollama.
 *
 * Scenarios:
 * 1. Cache-hit → no throw, result is 'cache-hit'.
 * 2. Generated → no throw, result is 'generated'.
 * 3. Group not found → throws.
 * 4. summarize failure → rethrows so bus can retry.
 */

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Cursor } from "../../db/repositories/read-watermarks.js";
import type { Job } from "../../jobs/job-types.js";
import type { PreparedSumbox } from "../../summarization/prepare-sumbox.js";
import type { SummaryPrompt } from "../../summarization/summarizer.js";
import { makeSummarizeGroupHandler } from "./summarize-group.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeJob(groupId: string): Job<"summarize.group"> {
  return {
    id: "test-job-sg-1",
    type: "summarize.group",
    payload: { groupId },
    attempts: 1,
    maxAttempts: 3,
  };
}

/**
 * Minimal fake pg.Pool that returns a group row for the given groupId.
 */
function makeFakePool(groupName: string | null): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: groupName !== null ? [{ name: groupName }] : [],
    }),
  } as unknown as pg.Pool;
}

function makeCacheHitSumbox(): PreparedSumbox {
  return { kind: "cache-hit", summary: { overview: "cached text" }, generatedAt: new Date() };
}

function makeReadySumbox(): PreparedSumbox {
  return {
    kind: "ready",
    groupId: 1,
    prompt: { system: "sys", user: "usr" } as SummaryPrompt,
    summaryType: "watermark",
    parameters: {
      fromExclusive: null,
      toInclusive: { sentAt: new Date().toISOString(), messageId: 1 },
      messageCount: 5,
      usedFallback: false,
    },
    messageCount: 5,
    newWatermark: { sentAt: new Date(), messageId: 1 } as Cursor,
    usedFallback: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeSummarizeGroupHandler", () => {
  it("resolves without error on cache-hit (idempotent — already current)", async () => {
    const pool = makeFakePool("Test Group");
    const prepareSumbox = vi.fn().mockResolvedValue(makeCacheHitSumbox());
    const summarize = vi.fn();
    const insertSummary = vi.fn();
    const updateWatermark = vi.fn();

    const handler = makeSummarizeGroupHandler({
      pool,
      prepareSumbox,
      summarize,
      insertSummary,
      updateWatermark,
      model: "gemma4:26b",
      tokenBudget: 24000,
    });

    await expect(handler(makeJob("1"))).resolves.toBeUndefined();
    // No summarization call on cache-hit
    expect(summarize).not.toHaveBeenCalled();
  });

  it("resolves without error on generated (new messages → summary written)", async () => {
    const pool = makeFakePool("Test Group");
    const prepareSumbox = vi.fn().mockResolvedValue(makeReadySumbox());
    const summarize = vi.fn().mockResolvedValue("Generated summary text");
    const insertSummary = vi.fn().mockResolvedValue(42);
    const updateWatermark = vi.fn().mockResolvedValue(undefined);

    const handler = makeSummarizeGroupHandler({
      pool,
      prepareSumbox,
      summarize,
      insertSummary,
      updateWatermark,
      model: "gemma4:26b",
      tokenBudget: 24000,
    });

    await expect(handler(makeJob("1"))).resolves.toBeUndefined();
    expect(summarize).toHaveBeenCalledOnce();
    expect(insertSummary).toHaveBeenCalledOnce();
    expect(updateWatermark).toHaveBeenCalledOnce();
  });

  it("runs entity extraction on the generated path (digest fills the To-dos tab)", async () => {
    const pool = makeFakePool("Test Group");
    const refreshEntities = vi.fn().mockResolvedValue(undefined);

    const handler = makeSummarizeGroupHandler({
      pool,
      prepareSumbox: vi.fn().mockResolvedValue(makeReadySumbox()),
      summarize: vi.fn().mockResolvedValue("Generated summary text"),
      insertSummary: vi.fn().mockResolvedValue(42),
      updateWatermark: vi.fn().mockResolvedValue(undefined),
      refreshEntities,
      model: "gemma4:26b",
      tokenBudget: 24000,
    });

    await handler(makeJob("1"));
    expect(refreshEntities).toHaveBeenCalledOnce();
  });

  it("throws when the group is not found in the DB", async () => {
    const pool = makeFakePool(null); // no rows returned
    const prepareSumbox = vi.fn();
    const summarize = vi.fn();
    const insertSummary = vi.fn();
    const updateWatermark = vi.fn();

    const handler = makeSummarizeGroupHandler({
      pool,
      prepareSumbox,
      summarize,
      insertSummary,
      updateWatermark,
      model: "gemma4:26b",
      tokenBudget: 24000,
    });

    await expect(handler(makeJob("99"))).rejects.toThrow(/99/);
    expect(prepareSumbox).not.toHaveBeenCalled();
  });

  it("rethrows when summarize throws (so the bus retries)", async () => {
    const pool = makeFakePool("Test Group");
    const prepareSumbox = vi.fn().mockResolvedValue(makeReadySumbox());
    const summarize = vi.fn().mockRejectedValue(new Error("Ollama down"));
    const insertSummary = vi.fn();
    const updateWatermark = vi.fn();

    const handler = makeSummarizeGroupHandler({
      pool,
      prepareSumbox,
      summarize,
      insertSummary,
      updateWatermark,
      model: "gemma4:26b",
      tokenBudget: 24000,
    });

    await expect(handler(makeJob("1"))).rejects.toThrow("Ollama down");
    expect(insertSummary).not.toHaveBeenCalled();
    expect(updateWatermark).not.toHaveBeenCalled();
  });

  it("throws on invalid groupId payload", async () => {
    const pool = makeFakePool("Test Group");
    const handler = makeSummarizeGroupHandler({
      pool,
      prepareSumbox: vi.fn(),
      summarize: vi.fn(),
      insertSummary: vi.fn(),
      updateWatermark: vi.fn(),
      model: "gemma4:26b",
      tokenBudget: 24000,
    });

    await expect(handler(makeJob("not-a-number"))).rejects.toThrow(/Invalid groupId/);
  });
});
