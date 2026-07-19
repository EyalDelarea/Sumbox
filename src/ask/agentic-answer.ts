import { type LanguageModel, generateText as sdkGenerateText, stepCountIs } from "ai";
import type pg from "pg";
import { resolveSenderName } from "../summarization/sender-name.js";
import { makeSearchChatTool } from "./agentic-tools.js";
import { attributeSources } from "./attribution.js";
import type { CitedAnswer } from "./citations.js";
import type { Embedder } from "./embedder.js";
import {
  askerLine,
  buildAgenticSystem,
  citeTag,
  fenceRetrieved,
  NOT_IN_CHAT,
  neutralizeFence,
  renderWindow,
} from "./prompt.js";
import { selectRecentMessages } from "./recent-window.js";
import { searchMessagesHybrid } from "./retrieval.js";

type GenerateFn = (
  opts: Parameters<typeof sdkGenerateText>[0],
) => Promise<{ text: string; steps: unknown[] }>;

/** Trace-level attributes (sessionId/userId/tags) for grouping in Langfuse.
 *  Mirrors observability/langfuse.ts TraceAttributes without importing it here,
 *  so this module carries no static Langfuse dependency. */
export type AgenticTrace = { sessionId?: string; userId?: string; tags?: string[] };

/** Wrap a call so trace attributes propagate onto the spans it creates.
 *  Injected (default lazily loads observability/langfuse.ts) so @langfuse/core
 *  never loads unless telemetry + trace are both set. */
type PropagateFn = <T>(attrs: AgenticTrace, fn: () => Promise<T>) => Promise<T>;

/** Matches answer.ts — one concept, one number. */
const DEFAULT_WINDOW_N = 20;
/** Matches answer.ts. */
const DEFAULT_RETRIEVE_K = 40;

export type AgenticDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  maxSteps?: number;
  /** How many recent messages to always show. Default 20. */
  windowN?: number;
  /** How many search hits to pre-seed. Default 40 — matches answerQuestion. */
  retrieveK?: number;
  /**
   * Sampling temperature. Left UNSET in prod so @Aida keeps the model's default
   * warmth; the eval harness pins it to 0.
   *
   * Why that matters: unpinned sampling made an identical run score 0.17 then
   * 0.33 on the same code, a ±0.17 noise floor WIDER than most effects worth
   * detecting — which is how a reverted prompt change got mis-blamed for a
   * regression that was really sampling noise.
   */
  temperature?: number;
  /** When true, emit OpenTelemetry spans for the loop (steps, tool calls, args,
   *  results, tokens, latency). Routed to the local Langfuse by the exporter
   *  started at collector startup (see src/observability/langfuse.ts). Off by
   *  default so the working path is unchanged when observability is disabled. */
  telemetry?: boolean;
  /** Trace-level attributes stamped on this run's spans (only when telemetry). */
  trace?: AgenticTrace;
  /**
   * Probe: message ids surfaced by each search_chat call, in rank order.
   * Fired once per tool call, so a multi-step loop reports each step separately.
   * Used by the eval harness to attribute a refusal to retrieval vs generation;
   * prod passes nothing.
   */
  onRetrieved?: (messageIds: number[]) => void;
  /**
   * Probe: the recency window's message ids.
   *
   * SEPARATE from onRetrieved because the window is context she never asked for,
   * while onRetrieved is context she went looking for — the eval harness must
   * union them to know what was IN CONTEXT, but keep them apart to tell whether
   * she searched. Counting only search results would blame retrieval for a
   * refusal she made while holding the answer in the window.
   */
  onWindow?: (messageIds: number[]) => void;
  /** Injectable for tests; defaults to the AI SDK. */
  generate?: GenerateFn;
  /** Injectable for tests; defaults to observability/langfuse.ts withTraceAttributes. */
  propagate?: PropagateFn;
};

/** Answer via a bounded agentic loop on gemma4. groupId is the privacy boundary
 *  (a closure in the tool). Empty output falls back to the grounded refusal. */
export async function answerAgentic(
  deps: AgenticDeps,
  input: {
    groupId: number;
    question: string;
    asOf?: Date;
    excludeExternalId?: string;
    askerName?: string;
  },
): Promise<CitedAnswer> {
  const generate = deps.generate ?? (sdkGenerateText as unknown as GenerateFn);

  const searchChat = makeSearchChatTool({
    pool: deps.pool,
    embedder: deps.embedder,
    groupId: input.groupId,
    question: input.question,
    ...(deps.onRetrieved ? { onRetrieved: deps.onRetrieved } : {}),
  });

  /**
   * The recency window, INJECTED rather than offered as a tool.
   *
   * A `read_recent` tool she could choose not to call would leave the bug intact
   * exactly when it bites — measured baseline: she refused with ZERO search_chat
   * calls on the very question the window answers. Handing it to her
   * unconditionally is the point.
   *
   * This path must carry the window or flipping ASK_AGENTIC would silently revert
   * the fix; answer-dispatch routes between the two on that flag alone.
   */
  const window = await selectRecentMessages(deps.pool, {
    groupId: input.groupId,
    n: deps.windowN ?? DEFAULT_WINDOW_N,
    asOf: input.asOf ?? new Date(),
    ...(input.excludeExternalId ? { excludeExternalId: input.excludeExternalId } : {}),
  });

  deps.onWindow?.(window.map((m) => m.messageId));

  /**
   * Pre-seed the SAME hybrid search the single-shot path runs, instead of
   * trusting the model to call search_chat.
   *
   * Measured: handed a recency window, gemma4 stopped calling search_chat
   * ENTIRELY (tool_called 0.67 → 0.00) and false-denied a fact that search
   * retrieves at hitRate 1.00 — it answered "לא מצאתי" about a message sitting
   * in the index. A small model with a full context does not reliably choose to
   * search, and no prompt rule moved it. Correctness must not depend on that
   * choice; search_chat stays for refinement, but the first result set is handed
   * over unconditionally, exactly as answerQuestion does.
   */
  const preEmbedding = await deps.embedder.embed(input.question);
  const preHits = await searchMessagesHybrid(
    deps.pool,
    input.groupId,
    { embedding: preEmbedding, text: input.question },
    deps.retrieveK ?? DEFAULT_RETRIEVE_K,
  );
  const windowIds = new Set(window.map((m) => m.messageId));
  const freshHits = preHits.filter((h) => !windowIds.has(h.messageId));
  deps.onRetrieved?.(freshHits.map((h) => h.messageId));

  const searchSection =
    freshHits.length > 0
      ? [
          "Older messages from this group's history, found by searching for this question:",
          fenceRetrieved(
            freshHits.map(
              (h) =>
                `${neutralizeFence(resolveSenderName(h.sender))}: ${neutralizeFence(h.content)}`,
            ),
          ),
          "",
        ]
      : [];

  const opts = {
    model: deps.model,
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    system: buildAgenticSystem(),
    prompt: [
      ...renderWindow(window),
      ...searchSection,
      ...askerLine(input.askerName),
      neutralizeFence(input.question),
    ].join("\n"),
    stopWhen: stepCountIs(deps.maxSteps ?? 3),
    tools: { search_chat: searchChat },
    // AI SDK v7 auto-enables telemetry once a Langfuse integration is
    // registered; isEnabled:false hard-opts-out when observability is off.
    experimental_telemetry: {
      isEnabled: deps.telemetry === true,
      functionId: "aida-agentic-answer",
    },
  } as Parameters<typeof sdkGenerateText>[0];
  // With telemetry + trace attrs, wrap the WHOLE turn — generation AND the
  // attribution pass — so sessionId/userId/tags propagate onto every span (AI
  // SDK v7 has no per-call metadata field). Attribution used to run outside
  // this scope and its trace landed session-less in Langfuse, which made the
  // one live debugging session that needed it a manual hunt.
  const run = async (): Promise<CitedAnswer> => {
    const { text } = await generate(opts);
    const trimmed = (text ?? "").trim();
    if (trimmed.length === 0) return { text: NOT_IN_CHAT, citedIds: [] };

    // Post-hoc: the answer above is already final and was produced from a
    // prompt with no ids in it. This pass only labels it — it cannot change a
    // word.
    const citedIds = await attributeSources(
      { model: deps.model, ...(deps.generate ? { generate: deps.generate } : {}) },
      { question: input.question, answer: trimmed, candidates: [...window, ...freshHits] },
    );
    return { text: trimmed, citedIds };
  };
  return deps.telemetry && deps.trace
    ? await (deps.propagate ?? (await import("../observability/langfuse.js")).withTraceAttributes)(
        deps.trace,
        run,
      )
    : await run();
}
