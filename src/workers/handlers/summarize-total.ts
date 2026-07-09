import type pg from "pg";
import type { InsertTotalSummaryInput } from "../../db/repositories/total-summaries.js";
import type { Job } from "../../jobs/job-types.js";
import type { TotalSummaryOutput } from "../../summarization/total-types.js";

export type SummarizeTotalHandlerDeps = {
  pool: pg.Pool;
  generateTotalSummary: (range: { since: Date }) => Promise<TotalSummaryOutput>;
  insertTotalSummary: (pool: pg.Pool, input: InsertTotalSummaryInput) => Promise<number>;
  model: string;
};

/**
 * Factory for the summarize.total job handler. Parses `since`, runs the
 * map-reduce total summary, and persists one scheduled total_summaries row.
 * Throws on bad payload / generation failure so the bus retries.
 */
export function makeSummarizeTotalHandler(deps: SummarizeTotalHandlerDeps) {
  return async function summarizeTotalHandler(job: Job<"summarize.total">): Promise<void> {
    const since = new Date(job.payload.since);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`Invalid since in summarize.total payload: ${job.payload.since}`);
    }
    const output = await deps.generateTotalSummary({ since });
    await deps.insertTotalSummary(deps.pool, {
      rangeKind: "scheduled",
      parameters: { since: since.toISOString() },
      output,
      model: deps.model,
    });
  };
}
