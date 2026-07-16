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
  const { text } = await generate({
    model: deps.model,
    system: buildAgenticSystem(),
    prompt: neutralizeFence(input.question),
    stopWhen: stepCountIs(deps.maxSteps ?? 3),
    tools: { search_chat: searchChat },
  } as Parameters<typeof sdkGenerateText>[0]);
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 ? trimmed : NOT_IN_CHAT;
}
