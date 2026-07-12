import type pg from "pg";
import type { Cursor } from "../db/repositories/read-watermarks.js";
import type { InsertSummaryInput } from "../db/repositories/summaries.js";
import { parseStructuredSummary } from "./parse-structured.js";
import type { PreparedSumbox } from "./prepare-sumbox.js";
import type { GenUsage, SummarizeOpts, SummaryOutput, SummaryPrompt } from "./summarizer.js";
import { withGenUsage } from "./usage-parameters.js";

export type { InsertSummaryInput };

/**
 * The "ready" state from prepareSumbox with the full text already generated.
 * Passed to persistSumboxResult so the server can stream tokens independently
 * and then commit with the same helper that summarizeAndPersist uses.
 */
export type SumboxResultToPersist = {
  pool: pg.Pool;
  groupId: number;
  summaryType: "watermark";
  parameters: Record<string, unknown>;
  /** The parsed structured summary to persist (or legacy {overview} prose). */
  output: SummaryOutput;
  model: string;
  newWatermark: Cursor;
  insertSummary: (pool: pg.Pool, input: InsertSummaryInput) => Promise<number>;
  updateWatermark: (pool: pg.Pool, groupId: number, cursor: Cursor) => Promise<void>;
};

/**
 * Shared commit step for a completed sumbox run.
 *
 * Writes the summary row FIRST, then advances the watermark.
 * Shared between the non-streaming scheduled-job path (summarizeAndPersist)
 * and the streaming serve path (/api/summarize?mode=sumbox).
 *
 * Returns the new summary row id.
 */
export async function persistSumboxResult(opts: SumboxResultToPersist): Promise<number> {
  const {
    pool,
    groupId,
    summaryType,
    parameters,
    output,
    model,
    newWatermark,
    insertSummary,
    updateWatermark,
  } = opts;

  const summaryId = await insertSummary(pool, {
    groupId,
    summaryType,
    parameters,
    output,
    model,
  });

  await updateWatermark(pool, groupId, newWatermark);

  return summaryId;
}

export type StreamSummaryResult =
  | { aborted: true }
  | { aborted: false; output: SummaryOutput; summaryId: number };

/**
 * The single streaming spine shared by the /api/summarize SSE handler's three
 * variants (sumbox / regenerate / last-since), which previously reimplemented it
 * inline. It mirrors the accumulate → parse → commit shape that the non-streaming
 * `summarizeAndPersist` implements one-shot (a parallel implementation, not a
 * shared call path — that core takes a full-string `summarize()` and also
 * materializes entities). It:
 *   1. accumulates the full prose from a token iterable, emitting each delta to
 *      `onToken` (the SSE handler sends a `token` event; the batch path passes
 *      no sink),
 *   2. guards against a mid-stream client disconnect — if `signal` aborted, it
 *      returns `{ aborted: true }` and commits NOTHING (no partial summary, no
 *      watermark advance),
 *   3. parses the completed prose into the fielded schema once, and
 *   4. commits via the caller's `persist` policy (sumbox advances the read
 *      watermark via persistSumboxResult; regenerate/last-since insert only).
 *
 * Callers differ ONLY by token source, `onToken` sink, and `persist` policy.
 */
export async function streamSummary(args: {
  tokens: AsyncIterable<string>;
  indexMap: Map<number, number>;
  persist: (output: SummaryOutput) => Promise<number>;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}): Promise<StreamSummaryResult> {
  let full = "";
  for await (const delta of args.tokens) {
    full += delta;
    args.onToken?.(delta);
  }
  // Client disconnected mid-stream → never commit a partial or advance a watermark.
  if (args.signal?.aborted) {
    return { aborted: true };
  }
  const output = parseStructuredSummary(full, args.indexMap);
  const summaryId = await args.persist(output);
  return { aborted: false, output, summaryId };
}

/**
 * Injected dependencies for summarizeAndPersist.
 * All I/O is injected for testability — no live Ollama or DB required in tests.
 */
export type SummarizeAndPersistDeps = {
  pool: pg.Pool;
  /** Resolves the group name → prepared sumbox state (cache-hit / empty / ready). */
  prepareSumbox: (
    pool: pg.Pool,
    groupName: string,
    fallbackN: number,
    tokenBudget: number,
  ) => Promise<PreparedSumbox>;
  /**
   * Calls the summarization model and returns the full output text. `opts` carries
   * the onUsage callback — an engine that ignores it simply records no token counts.
   */
  summarize: (prompt: SummaryPrompt, opts?: SummarizeOpts) => Promise<string>;
  /** Injected clock so genMs is deterministic under test. Defaults to Date.now. */
  now?: () => number;
  /** Persists the summary row. */
  insertSummary: (pool: pg.Pool, input: InsertSummaryInput) => Promise<number>;
  /** Advances the read watermark for the group. */
  updateWatermark: (pool: pg.Pool, groupId: number, cursor: Cursor) => Promise<void>;
  /** Ollama model label stored in the summary row. */
  model: string;
  /** Token budget passed to prepareSumbox. */
  tokenBudget: number;
  /** Group name used to resolve the group in prepareSumbox. */
  groupName: string;
  /**
   * Optional: materialize meetings/todos/people from the just-persisted structured
   * summary. Best-effort by contract (must never throw) — wire it to
   * `materializeEntities` so the digest path fills the To-dos tab. Omitted →
   * extraction is skipped (back-compat for callers that don't want it).
   */
  refreshEntities?: (pool: pg.Pool, groupId: number, output: SummaryOutput) => Promise<void>;
};

export type SummarizeResult = { status: "generated" | "cache-hit" };

/**
 * Shared, non-streaming summarize-and-cache core.
 *
 * 1. prepareSumbox — if cache-hit or no messages, returns { status: 'cache-hit' } (no writes).
 * 2. Calls the injected summarize(prompt) for the full text.
 * 3. insertSummary — writes the summary row FIRST.
 * 4. updateWatermark — advances the read cursor only after the summary is committed.
 *    A failure in step 3 throws before reaching step 4 (no partial state).
 *
 * Used by both the scheduled job handler and (after T008 refactor) the on-demand
 * serve path. Only token streaming differs between the two callers.
 */
export async function summarizeAndPersist(
  deps: SummarizeAndPersistDeps,
  groupId: number,
): Promise<SummarizeResult> {
  const {
    pool,
    prepareSumbox,
    summarize,
    insertSummary,
    updateWatermark,
    model,
    tokenBudget,
    groupName,
    refreshEntities,
  } = deps;
  const now = deps.now ?? Date.now;

  const FALLBACK_N = 25;
  const prepared = await prepareSumbox(pool, groupName, FALLBACK_N, tokenBudget);

  if (prepared.kind === "cache-hit" || prepared.kind === "empty") {
    return { status: "cache-hit" };
  }

  // kind === "ready"
  // The scheduled path previously recorded messageCount but no duration at all,
  // so the runs that hurt most were the ones with no telemetry whatsoever.
  let usage: GenUsage | undefined;
  const startedAt = now();
  const fullText = await summarize(prepared.prompt, {
    onUsage: (u) => {
      usage = u;
    },
  });
  const genMs = now() - startedAt;
  const output = parseStructuredSummary(fullText, prepared.indexMap);

  // Shared commit step: summary first, watermark second (no partial state).
  await persistSumboxResult({
    pool,
    groupId: prepared.groupId,
    summaryType: prepared.summaryType,
    parameters: withGenUsage(prepared.parameters, {
      genMs,
      usage,
      estimatedTokens: prepared.estimatedTokens,
    }),
    output,
    model,
    newWatermark: prepared.newWatermark,
    insertSummary,
    updateWatermark,
  });

  // Materialize meetings/todos/people from the structured decisions. This is what
  // makes the scheduled digest (and CLI digest-run) fill the To-dos tab — without
  // it, only the browser SSE path ever extracts. Best-effort by the dep's contract.
  if (refreshEntities) {
    await refreshEntities(pool, prepared.groupId, output);
  }

  return { status: "generated" };
}
