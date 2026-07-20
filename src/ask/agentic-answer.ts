import { type LanguageModel, generateText as sdkGenerateText, stepCountIs } from "ai";
import type pg from "pg";
import { makeSearchChatTool } from "./agentic-tools.js";
import { attributeSources } from "./attribution.js";
import type { CitedAnswer } from "./citations.js";
import type { Embedder } from "./embedder.js";
import { ungroundedNumerals } from "./groundedness.js";
import {
  askerLine,
  buildAgenticSystem,
  fenceRetrieved,
  NOT_IN_CHAT,
  neutralizeFence,
  Q_CLOSE,
  Q_OPEN,
  renderLine,
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

/**
 * The groundedness guard's view of a tool step: only the RESULT — something
 * she was shown — not `text`/`content`, which echo her own draft for that
 * step and would self-ground any fabrication if included.
 */
const toolResultText = (steps: unknown[] | undefined): string =>
  JSON.stringify(
    (steps ?? []).flatMap((s) => (s as { toolResults?: unknown[] }).toolResults ?? []),
  );

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
  /**
   * Probe: the INITIAL grounding corpus — window + pre-seeded hits + question +
   * system, assembled the same way the real call is. Fired once, right before
   * the generation call, so it reflects only what she was handed up front: a
   * mid-loop search_chat result is NOT included (those live in `steps`, which
   * this probe never sees). Used by the eval harness's ungrounded_number
   * metric; prod passes nothing. The runtime guard (`groundednessGuard`)
   * separately accounts for `steps` — see the WHY comment at its call site.
   */
  onPrompt?: (prompt: string) => void;
  /**
   * Runtime guard: after generation, refuse or retry once if the answer
   * asserts a numeral that appears nowhere in what she was shown (see
   * ask/groundedness.ts). Default OFF — the eval harness's ungrounded_number
   * metric already MEASURES this; this flag is what would eventually ACT on
   * it, kept behind a flag until the eval proves the retry doesn't regress
   * other metrics (e.g. trading a correct answer for an unnecessary refusal).
   */
  groundednessGuard?: boolean;
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
          // Dated and attributed like every other rendered line. This block used
          // to carry neither, which is what the field report measured: 11 of 11
          // retrieved lines anonymous, in a turn where she was asked to prove
          // that ROYI specifically had said something. No citeTag here on
          // purpose — these hits reach the citation space through the post-hoc
          // attribution pass, not through the prompt.
          fenceRetrieved(freshHits.map((h) => renderLine(h))),
          "",
        ]
      : [];

  const system = buildAgenticSystem();
  const prompt = [
    ...renderWindow(window),
    ...searchSection,
    ...askerLine(input.askerName),
    // Fenced exactly like the single-shot path (buildAskPrompt). Neutralizing alone
    // already made a forged ⟦…⟧ marker impossible, but the question still arrived as
    // a bare trailing line — indistinguishable from the instructions above it, while
    // the SECURITY clause told the model the question would be wrapped in markers.
    // The fence makes that promise true.
    "The question to answer:",
    Q_OPEN,
    neutralizeFence(input.question),
    Q_CLOSE,
  ].join("\n");

  const opts = {
    model: deps.model,
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    system,
    prompt,
    stopWhen: stepCountIs(deps.maxSteps ?? 3),
    tools: { search_chat: searchChat },
    // AI SDK v7 auto-enables telemetry once a Langfuse integration is
    // registered; isEnabled:false hard-opts-out when observability is off.
    experimental_telemetry: {
      isEnabled: deps.telemetry === true,
      functionId: "aida-agentic-answer",
    },
  } as Parameters<typeof sdkGenerateText>[0];
  // The probe hands the eval the EXACT grounding corpus — window + pre-seeded
  // hits + question + system — so the ungrounded_number metric can never
  // drift from what she saw.
  deps.onPrompt?.(`${system}\n${prompt}`);
  // With telemetry + trace attrs, wrap the WHOLE turn — generation AND the
  // attribution pass — so sessionId/userId/tags propagate onto every span (AI
  // SDK v7 has no per-call metadata field). Attribution used to run outside
  // this scope and its trace landed session-less in Langfuse, which made the
  // one live debugging session that needed it a manual hunt.
  const run = async (): Promise<CitedAnswer> => {
    const { text, steps } = await generate(opts);
    let answerText = (text ?? "").trim();
    if (answerText.length === 0) return { text: NOT_IN_CHAT, citedIds: [] };

    if (deps.groundednessGuard === true) {
      // WHY only toolResults, not the whole step: AI SDK v7's StepResult.text
      // and .content ECHO the model's own generated text for that step — for
      // the common no-tool-call case, steps[0].text IS the very answer being
      // checked. Stringifying the whole step would self-ground every
      // fabrication (the numeral is always "present" because the step just
      // repeats it) and make the guard a no-op for exactly the scenario it
      // exists for. toolResults are the one part of a step that's genuinely
      // something she was SHOWN (not something she SAID), so — mirroring
      // onRetrieved's union of mid-loop search_chat hits into "what was
      // retrieved" — only toolResults belong in the corpus.
      const corpus = `${system}\n${prompt}\n${toolResultText(steps)}`;
      let novel = ungroundedNumerals(answerText, corpus);
      if (novel.length > 0) {
        // One corrective retry: the number is the ONLY thing challenged, so a
        // mostly-right answer keeps its substance and drops the invention.
        // The retry fires only on a failed check, so the happy path costs
        // zero extra inference.
        const retry = await generate({
          ...opts,
          system: `${system}\nGROUNDING CHECK: your draft asserted the number(s) ${novel.join(", ")} which appear in NO message you were shown. Rewrite the answer without any unsupported number — or, if the answer depends on it, refuse with '${NOT_IN_CHAT}'.`,
        } as Parameters<typeof sdkGenerateText>[0]);
        const retried = (retry.text ?? "").trim();
        const retryCorpus = `${system}\n${prompt}\n${toolResultText(retry.steps)}`;
        novel = retried.length === 0 ? novel : ungroundedNumerals(retried, retryCorpus);
        // Still inventing → the clean refusal beats a confident fabrication.
        // Persona-prefixed like every refusal SHE produces (the system prompt
        // mandates the prefix), so a guard-forced refusal is indistinguishable
        // in tone from one she chose herself. A refusal has no source, so
        // attribution is skipped — matching attribution.ts's REFUSALS rule.
        if (novel.length > 0 || retried.length === 0) {
          return { text: `תכף תכף... ${NOT_IN_CHAT}`, citedIds: [] };
        }
        answerText = retried;
      }
    }

    // Post-hoc: the answer above is already final and was produced from a
    // prompt with no ids in it. This pass only labels it — it cannot change a
    // word.
    const citedIds = await attributeSources(
      { model: deps.model, ...(deps.generate ? { generate: deps.generate } : {}) },
      { question: input.question, answer: answerText, candidates: [...window, ...freshHits] },
    );
    return { text: answerText, citedIds };
  };
  return deps.telemetry && deps.trace
    ? await (deps.propagate ?? (await import("../observability/langfuse.js")).withTraceAttributes)(
        deps.trace,
        run,
      )
    : await run();
}
