import { type LanguageModel, generateText as sdkGenerateText, stepCountIs } from "ai";
import type pg from "pg";
import { makeSearchChatTool } from "./agentic-tools.js";
import type { Embedder } from "./embedder.js";
import { buildAgenticSystem, NOT_IN_CHAT, neutralizeFence } from "./prompt.js";

type GenerateFn = (
  opts: Parameters<typeof sdkGenerateText>[0],
) => Promise<{ text: string; steps: unknown[] }>;

export type AgenticDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  model: LanguageModel;
  maxSteps?: number;
  /** When true, emit OpenTelemetry spans for the loop (steps, tool calls, args,
   *  results, tokens, latency). Routed to the local Langfuse by the exporter
   *  started at collector startup (see src/observability/langfuse.ts). Off by
   *  default so the working path is unchanged when observability is disabled. */
  telemetry?: boolean;
  /** Injectable for tests; defaults to the AI SDK. */
  generate?: GenerateFn;
};

/** Answer via a bounded agentic loop on gemma4. groupId is the privacy boundary
 *  (a closure in the tool). Empty output falls back to the grounded refusal. */
export async function answerAgentic(
  deps: AgenticDeps,
  input: { groupId: number; question: string },
): Promise<string> {
  const generate = deps.generate ?? (sdkGenerateText as unknown as GenerateFn);
  const searchChat = makeSearchChatTool({
    pool: deps.pool,
    embedder: deps.embedder,
    groupId: input.groupId,
    question: input.question,
  });
  const opts = {
    model: deps.model,
    system: buildAgenticSystem(),
    prompt: neutralizeFence(input.question),
    stopWhen: stepCountIs(deps.maxSteps ?? 3),
    tools: { search_chat: searchChat },
    // AI SDK v7 auto-enables telemetry once a Langfuse integration is
    // registered; isEnabled:false hard-opts-out when observability is off.
    experimental_telemetry: {
      isEnabled: deps.telemetry === true,
      functionId: "aida-agentic-answer",
    },
  } as Parameters<typeof sdkGenerateText>[0];
  const { text } = await generate(opts);
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 ? trimmed : NOT_IN_CHAT;
}
