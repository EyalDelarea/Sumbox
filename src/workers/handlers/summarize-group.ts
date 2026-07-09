/**
 * makeSummarizeGroupHandler — factory for the summarize.group job handler.
 *
 * Behaviour:
 * 1. Parse groupId from the job payload.
 * 2. Call summarizeAndPersist(deps, groupId) — the shared non-streaming core.
 * 3. Return on success (cache-hit and generated are both OK).
 * 4. Throw on failure so the bus retries (→ dead-letter after N attempts).
 *
 * Idempotent: if the group's cache is already current, summarizeAndPersist
 * is a no-op — safe on redelivery.
 *
 * All I/O is injected via deps for testability.
 */

import type pg from "pg";
import type { Cursor } from "../../db/repositories/read-watermarks.js";
import type { Job } from "../../jobs/job-types.js";
import type { PreparedSumbox } from "../../summarization/prepare-sumbox.js";
import type { InsertSummaryInput } from "../../summarization/run-summary.js";
import { summarizeAndPersist } from "../../summarization/run-summary.js";
import type { SummaryOutput, SummaryPrompt } from "../../summarization/summarizer.js";

export type SummarizeGroupHandlerDeps = {
  pool: pg.Pool;
  prepareSumbox: (
    pool: pg.Pool,
    groupName: string,
    fallbackN: number,
    tokenBudget: number,
  ) => Promise<PreparedSumbox>;
  summarize: (prompt: SummaryPrompt) => Promise<string>;
  insertSummary: (pool: pg.Pool, input: InsertSummaryInput) => Promise<number>;
  updateWatermark: (pool: pg.Pool, groupId: number, cursor: Cursor) => Promise<void>;
  /** Best-effort entity materialization (meetings/todos/people) — see materializeEntities. */
  refreshEntities?: (pool: pg.Pool, groupId: number, output: SummaryOutput) => Promise<void>;
  model: string;
  tokenBudget: number;
};

/**
 * Factory that returns a `summarize.group` job handler.
 *
 * The handler uses groupId to look up the group name (via groups repo), then
 * delegates to summarizeAndPersist. Both cache-hit (no new messages) and
 * generated outcomes are considered successful completions — only exceptions
 * are rethrown for retry.
 */
export function makeSummarizeGroupHandler(deps: SummarizeGroupHandlerDeps) {
  return async function summarizeGroupHandler(job: Job<"summarize.group">): Promise<void> {
    const groupId = Number(job.payload.groupId);
    if (!Number.isFinite(groupId) || groupId <= 0) {
      throw new Error(`Invalid groupId in summarize.group payload: ${job.payload.groupId}`);
    }

    // Look up the group name so we can call summarizeAndPersist (which uses groupName
    // to resolve via prepareSumbox). We query the pool directly here since
    // the groups repo findGroupByName is used by prepareSumbox internally.
    const { rows } = await deps.pool.query<{ name: string }>(
      `SELECT name FROM groups WHERE id = $1`,
      [groupId],
    );
    if (rows.length === 0) {
      throw new Error(`summarize.group: group ${groupId} not found`);
    }
    const groupName = rows[0]!.name;

    await summarizeAndPersist(
      {
        pool: deps.pool,
        prepareSumbox: deps.prepareSumbox,
        summarize: deps.summarize,
        insertSummary: deps.insertSummary,
        updateWatermark: deps.updateWatermark,
        model: deps.model,
        tokenBudget: deps.tokenBudget,
        groupName,
        refreshEntities: deps.refreshEntities,
      },
      groupId,
    );
    // Both 'cache-hit' and 'generated' are successful completions.
    // Only exceptions propagate for bus retry.
  };
}
