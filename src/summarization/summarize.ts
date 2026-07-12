import pg from "pg";
import { loadConfig } from "../config.js";
import { insertSummary } from "../db/repositories/summaries.js";
import { prepareSummary, prepareSummaryForGroup } from "./prepare.js";
import { estimateTokens } from "./prompt.js";
import type { Selection } from "./select.js";
import {
  type GenUsage,
  OllamaSummarizer,
  type Summarizer,
  type SummaryOutput,
} from "./summarizer.js";
import { withGenUsage } from "./usage-parameters.js";

export type RunSummarizeInput = {
  groupName: string;
  selection: Selection;
};

export type RunSummarizeResult =
  | { kind: "empty" }
  | { kind: "ok"; output: SummaryOutput; summaryId: number };

type RunSummarizeDeps = {
  databaseUrl: string;
  summarizer: Summarizer;
  /** Model label recorded on the row. */
  model: string;
  tokenBudget: number;
  /** Injected clock so `genMs` is deterministic under test. */
  now: () => number;
};

/**
 * Fold usage telemetry into the summary row's `parameters`. These power the
 * feature-usage dashboard (adoption + real gen time) and fix the jobs-status
 * panel that otherwise borrows a scheduled job's duration.
 *
 * ponytail: kept in the existing jsonb `parameters` (no migration). Promote to
 * typed columns on `summaries` if aggregation gets heavy.
 *
 * `withGenUsage` adds the engine-reported half (real token counts, the
 * prompt-vs-generation split, truncated); this adds the who/why half.
 */
function withUsage(
  parameters: Record<string, unknown>,
  usage: {
    genMs: number;
    trigger: "command" | "scheduled";
    requesterId: number | null;
    messageCount: number;
    genUsage?: GenUsage;
    estimatedTokens: number;
  },
): Record<string, unknown> {
  const { genUsage, estimatedTokens, genMs, ...rest } = usage;
  return withGenUsage({ ...parameters, ...rest }, { genMs, usage: genUsage, estimatedTokens });
}

export async function runSummarize(
  input: RunSummarizeInput,
  deps?: Partial<RunSummarizeDeps>,
): Promise<RunSummarizeResult> {
  const config = loadConfig();
  const databaseUrl = deps?.databaseUrl ?? config.databaseUrl;
  const model = deps?.model ?? config.summarization.model;
  const tokenBudget = deps?.tokenBudget ?? config.summarization.tokenBudget;
  const now = deps?.now ?? Date.now;
  const summarizer: Summarizer =
    deps?.summarizer ??
    new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const prepared = await prepareSummary(pool, input.groupName, input.selection, tokenBudget);
    if (prepared.kind === "empty") return { kind: "empty" };

    let genUsage: GenUsage | undefined;
    const startedAt = now();
    const output = await summarizer.summarize(prepared.prompt, {
      onUsage: (u) => {
        genUsage = u;
      },
    });
    const summaryId = await insertSummary(pool, {
      groupId: prepared.groupId,
      summaryType: prepared.summaryType,
      parameters: withUsage(prepared.parameters, {
        genMs: now() - startedAt,
        trigger: "scheduled",
        requesterId: null,
        messageCount: prepared.messageCount,
        genUsage,
        estimatedTokens: estimateTokens(prepared.prompt.system + prepared.prompt.user),
      }),
      output,
      model,
    });
    return { kind: "ok", output, summaryId };
  } finally {
    await pool.end();
  }
}

/**
 * Summarize a group the caller ALREADY resolved (by JID, on a tenant-scoped
 * pool), keyed on `groupId`. Runs on the CALLER'S pool — it does NOT open a
 * fresh owner/BYPASSRLS pool and does NOT re-resolve the group by name. This is
 * the safe entry point for the `/סיכום` command reply: it keeps the summary
 * bounded to the exact verified group + tenant, closing the by-name / owner-pool
 * cross-chat/cross-tenant leak.
 */
export async function runSummarizeOnPool(
  pool: pg.Pool | pg.PoolClient,
  groupId: number,
  selection: Selection,
  deps?: Partial<Omit<RunSummarizeDeps, "databaseUrl">> & {
    /** The asker's participant id, stamped onto the row for adoption metrics. */
    requesterId?: number | null;
  },
): Promise<RunSummarizeResult> {
  const config = loadConfig();
  const model = deps?.model ?? config.summarization.model;
  const tokenBudget = deps?.tokenBudget ?? config.summarization.tokenBudget;
  const now = deps?.now ?? Date.now;
  const summarizer: Summarizer =
    deps?.summarizer ??
    new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });

  const prepared = await prepareSummaryForGroup(pool, groupId, selection, tokenBudget);
  if (prepared.kind === "empty") return { kind: "empty" };

  let genUsage: GenUsage | undefined;
  const startedAt = now();
  const output = await summarizer.summarize(prepared.prompt, {
    onUsage: (u) => {
      genUsage = u;
    },
  });
  const summaryId = await insertSummary(pool, {
    groupId: prepared.groupId,
    summaryType: prepared.summaryType,
    parameters: withUsage(prepared.parameters, {
      genMs: now() - startedAt,
      trigger: "command",
      requesterId: deps?.requesterId ?? null,
      messageCount: prepared.messageCount,
      genUsage,
      estimatedTokens: estimateTokens(prepared.prompt.system + prepared.prompt.user),
    }),
    output,
    model,
  });
  return { kind: "ok", output, summaryId };
}
