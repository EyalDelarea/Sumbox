/**
 * run-e.ts — drive Suite E through @Aida's REAL agentic loop.
 *
 * The impure half of Suite E: it owns the pool, the model and Langfuse, so
 * suite-e.ts's evaluators can stay pure. Read-only by construction — it calls
 * answerAgentic, never sendText/react, so it cannot post to WhatsApp even by
 * accident. Same stance as ask-sandbox.
 */

import type { LanguageModel } from "ai";
import type pg from "pg";
import { answerAgentic } from "../ask/agentic-answer.js";
import type { Embedder } from "../ask/embedder.js";
import type { GoldenItem } from "./golden.js";
import { evaluateAll, type SuiteESummary, summarize, type TaskOutput } from "./suite-e.js";

export type RunEDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  /** Emit OTel spans to the local Langfuse. */
  telemetry?: boolean;
  /** Injectable for tests; defaults to the real agentic loop. */
  answer?: typeof answerAgentic;
  onItem?: (id: string, out: TaskOutput) => void;
};

/**
 * Resolve gold external_ids → local message ids.
 *
 * Throws on an unresolvable id rather than scoring a miss: a purged or
 * re-imported message is a ROTTED golden item, and reading it as a retrieval
 * failure would report a regression that never happened.
 */
async function resolveGold(pool: pg.Pool | pg.PoolClient, item: GoldenItem): Promise<number[]> {
  if (item.goldExternalIds.length === 0) return [];
  const { rows } = await pool.query<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM messages WHERE group_id = $1 AND external_id = ANY($2::text[])`,
    [item.groupId, item.goldExternalIds],
  );
  if (rows.length !== item.goldExternalIds.length) {
    const found = new Set(rows.map((r) => r.external_id));
    throw new Error(
      `golden item ${item.id} has rotted: external_id(s) ${item.goldExternalIds
        .filter((e) => !found.has(e))
        .join(
          ", ",
        )} are absent from group ${item.groupId} — fix the golden set, do not read this as a retrieval miss`,
    );
  }
  return rows.map((r) => Number(r.id));
}

/**
 * Run one item through the real loop, capturing what she retrieved.
 *
 * The probe fires once per search_chat call, so `toolCalls` counts calls and
 * `retrievedIds` unions their results — a multi-step loop reports every step.
 * Zero calls is itself a finding (she refused without looking).
 */
export async function runItem(deps: RunEDeps, item: GoldenItem): Promise<TaskOutput> {
  const retrieved: number[][] = [];
  let windowIds: number[] = [];
  const goldIds = await resolveGold(deps.pool, item);
  const answerFn = deps.answer ?? answerAgentic;

  const answer = await answerFn(
    {
      pool: deps.pool,
      embedder: deps.embedder,
      model: deps.model,
      telemetry: deps.telemetry === true,
      trace: {
        sessionId: `eval:group:${item.groupId}`,
        userId: item.id,
        tags: ["aida", "eval", ...item.slice],
      },
      onRetrieved: (ids) => retrieved.push(ids),
      onWindow: (ids) => {
        windowIds = ids;
      },
    },
    { groupId: item.groupId, question: item.question, asOf: new Date(item.asOf) },
  );

  return {
    answer,
    // What was IN CONTEXT = what she searched for ∪ what she was handed.
    // Omitting the window would misattribute a refusal-with-the-answer-present
    // to retrieval, hiding the generation bug this harness exists to find.
    retrievedIds: [...new Set([...retrieved.flat(), ...windowIds])],
    goldIds,
    toolCalls: retrieved.length,
  };
}

/**
 * Run every item and evaluate. Sequential on purpose: the local Ollama serves one
 * model at a time, and concurrent calls would contend for the same GPU — making
 * latency meaningless and starving nothing but each other.
 */
export async function runSuiteE(deps: RunEDeps, items: GoldenItem[]): Promise<SuiteESummary> {
  const perItem: { id: string; evaluations: ReturnType<typeof evaluateAll> }[] = [];
  for (const item of items) {
    const output = await runItem(deps, item);
    deps.onItem?.(item.id, output);
    perItem.push({ id: item.id, evaluations: evaluateAll({ item, output }) });
  }
  return summarize(perItem);
}
