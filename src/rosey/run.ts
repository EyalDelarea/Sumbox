/**
 * run.ts — Rosey's aggregation bound to the real database and local Ollama.
 *
 * The composition point for every caller (the `rosey aggregate` CLI today), so
 * they all read the same messages, cursor, and store.
 */

import type pg from "pg";
import {
  insertTask,
  liveTasksRaisedBetween,
  resolveRaisedBy,
  selectSourceMessages,
} from "../db/repositories/rosey-tasks.js";
import { getLastRun, recordRun } from "../db/repositories/scheduler-state.js";
import { OllamaSummarizer } from "../summarization/summarizer.js";
import { type AggregateReport, aggregateMessages } from "./aggregate.js";
import type { RoseyConfig } from "./config.js";
import { makeTagMatcher } from "./tags.js";

export type Generate = (system: string, user: string) => Promise<string>;

/**
 * The local model as Rosey uses it: a plain prompt → text call through the
 * shared Ollama client. No `format: json` — on short Hebrew input gemma4 loops
 * when asked for structured output; the reply is parsed with lastJsonValue.
 * Low temperature: these are extraction calls, not prose.
 */
export function makeGenerate(cfg: RoseyConfig): Generate {
  const llm = new OllamaSummarizer({
    host: cfg.ollamaHost,
    model: cfg.model,
    numCtx: cfg.numCtx,
    temperature: 0.2,
    numPredict: 2048,
  });
  return async (system, user) => (await llm.summarize({ system, user })).overview;
}

/** The scheduler_state key holding a group's aggregation cursor (ingest time). */
export function cursorKey(groupId: number): string {
  return `rosey-aggregate:${groupId}`;
}

export type RunAggregationResult = {
  report: AggregateReport;
  /** False when any batch failed: those messages are read again next run. */
  cursorAdvanced: boolean;
};

export async function runAggregation(
  pool: pg.Pool,
  groupId: number,
  opts: {
    cfg: RoseyConfig;
    generate: Generate;
    /** Only messages sent within this many days are read. */
    days: number;
    /** Ignore the cursor and re-read the whole window. */
    fromScratch?: boolean;
    onBatchError?: (err: unknown, batch: { index: number; size: number }) => void;
    now?: () => Date;
  },
): Promise<RunAggregationResult> {
  const now = opts.now ?? (() => new Date());
  // Taken BEFORE reading, so a message ingested during the run is newer than
  // the cursor it leaves behind and is read next time.
  const startedAt = now();
  const changedSince = opts.fromScratch ? null : await getLastRun(pool, cursorKey(groupId));
  const messages = await selectSourceMessages(pool, groupId, {
    sentSince: new Date(startedAt.getTime() - opts.days * 86_400_000),
    changedSince,
  });

  const tags = makeTagMatcher(opts.cfg.tags);
  const report = await aggregateMessages(messages, {
    generate: opts.generate,
    isTagged: tags.isTagged,
    resolveRaisedBy: (ids) => resolveRaisedBy(pool, groupId, ids),
    liveTasksRaisedBetween: (since, until) => liveTasksRaisedBetween(pool, groupId, since, until),
    insertSuggestion: (input) => insertTask(pool, { ...input, groupId, origin: "suggested" }),
    onBatchError: opts.onBatchError,
  });

  const cursorAdvanced = report.batchFailures === 0;
  if (cursorAdvanced) await recordRun(pool, cursorKey(groupId), startedAt);
  return { report, cursorAdvanced };
}
