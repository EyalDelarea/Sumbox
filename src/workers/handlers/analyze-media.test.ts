/**
 * T010 — Tests for makeAnalyzeMediaHandler (src/workers/handlers/analyze-media.ts).
 *
 * All deps are injected fakes; no real DB or vision engine needed.
 */
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../jobs/job-types.js";
import { makeAnalyzeMediaHandler } from "./analyze-media.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(type: "analyze.image" | "analyze.video", messageId: string): Job<typeof type> {
  return {
    id: "test-job-am-1",
    type,
    payload: { messageId },
    attempts: 1,
    maxAttempts: 3,
  } as Job<typeof type>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeAnalyzeMediaHandler", () => {
  it("calls analyzeOne with (messageId as number, 'image') for analyze.image", async () => {
    const analyzeOne = vi.fn().mockResolvedValue(undefined);
    const hasAnalysis = vi.fn().mockResolvedValue(false);

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await handler(makeJob("analyze.image", "42"), "analyze.image");

    expect(analyzeOne).toHaveBeenCalledOnce();
    expect(analyzeOne).toHaveBeenCalledWith(42, "image");
  });

  it("calls analyzeOne with (messageId as number, 'video') for analyze.video", async () => {
    const analyzeOne = vi.fn().mockResolvedValue(undefined);
    const hasAnalysis = vi.fn().mockResolvedValue(false);

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await handler(makeJob("analyze.video", "99"), "analyze.video");

    expect(analyzeOne).toHaveBeenCalledOnce();
    expect(analyzeOne).toHaveBeenCalledWith(99, "video");
  });

  it("skips analyzeOne and returns early when hasAnalysis is true (completed — idempotent)", async () => {
    const analyzeOne = vi.fn();
    const hasAnalysis = vi.fn().mockResolvedValue(true);

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await handler(makeJob("analyze.image", "7"), "analyze.image");

    expect(hasAnalysis).toHaveBeenCalledWith(7);
    expect(analyzeOne).not.toHaveBeenCalled();
  });

  it("calls analyzeOne when hasAnalysis is false (failed row — retry path)", async () => {
    const analyzeOne = vi.fn().mockResolvedValue(undefined);
    // hasAnalysis returns false for a failed row (only completed rows return true)
    const hasAnalysis = vi.fn().mockResolvedValue(false);

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await handler(makeJob("analyze.image", "12"), "analyze.image");

    expect(hasAnalysis).toHaveBeenCalledWith(12);
    expect(analyzeOne).toHaveBeenCalledWith(12, "image");
  });

  it("resolves without error on successful analysis", async () => {
    const analyzeOne = vi.fn().mockResolvedValue(undefined);
    const hasAnalysis = vi.fn().mockResolvedValue(false);

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await expect(handler(makeJob("analyze.image", "5"), "analyze.image")).resolves.toBeUndefined();
  });

  it("rethrows when analyzeOne throws (so the bus retries)", async () => {
    const analyzeOne = vi.fn().mockRejectedValue(new Error("vision boom"));
    const hasAnalysis = vi.fn().mockResolvedValue(false);

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await expect(handler(makeJob("analyze.image", "3"), "analyze.image")).rejects.toThrow(
      "vision boom",
    );
  });

  it("does not call analyzeOne when hasAnalysis throws", async () => {
    const analyzeOne = vi.fn();
    const hasAnalysis = vi.fn().mockRejectedValue(new Error("db down"));

    const handler = makeAnalyzeMediaHandler({ hasAnalysis, analyzeOne });
    await expect(handler(makeJob("analyze.image", "1"), "analyze.image")).rejects.toThrow(
      "db down",
    );
    expect(analyzeOne).not.toHaveBeenCalled();
  });
});
