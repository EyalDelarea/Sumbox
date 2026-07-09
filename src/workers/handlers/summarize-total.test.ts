import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../jobs/job-types.js";
import type { TotalSummaryOutput } from "../../summarization/total-types.js";
import { makeSummarizeTotalHandler } from "./summarize-total.js";

function job(since: string): Job<"summarize.total"> {
  return { id: "1", type: "summarize.total", payload: { since }, attempts: 0, maxAttempts: 3 };
}

describe("summarize.total handler", () => {
  it("generates and persists a scheduled total summary", async () => {
    const output: TotalSummaryOutput = { highlights: "## דורש תשומת לב\n- x", perChat: [] };
    const generate = vi.fn().mockResolvedValue(output);
    const insert = vi.fn().mockResolvedValue(7);

    const handler = makeSummarizeTotalHandler({
      pool: {} as never,
      generateTotalSummary: generate,
      insertTotalSummary: insert,
      model: "gemma4:26b",
    });

    await handler(job("2026-06-06T00:00:00.000Z"));

    expect(generate).toHaveBeenCalledWith({ since: new Date("2026-06-06T00:00:00.000Z") });
    expect(insert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        rangeKind: "scheduled",
        output,
        model: "gemma4:26b",
      }),
    );
  });

  it("throws on an invalid since (so the bus retries / dead-letters)", async () => {
    const handler = makeSummarizeTotalHandler({
      pool: {} as never,
      generateTotalSummary: vi.fn(),
      insertTotalSummary: vi.fn(),
      model: "m",
    });
    await expect(handler(job("not-a-date"))).rejects.toThrow(/Invalid since/);
  });
});
