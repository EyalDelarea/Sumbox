import type pg from "pg";
import { estimateTokens } from "../summarization/prompt.js";
import type { Embedder } from "./embedder.js";
import {
  type AskContextMessage,
  type AskPrompt,
  buildAskPrompt,
  NOT_IN_CHAT,
  NOT_INDEXED,
} from "./prompt.js";
import { searchMessagesHybrid } from "./retrieval.js";

/** Generates the answer text from a built prompt (wraps the Ollama LLM). */
export interface AskLlm {
  answer(prompt: AskPrompt): Promise<string>;
}

export type AnswerDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  llm: AskLlm;
  /** How many messages to retrieve before budget-trimming. Default 40. */
  retrieveK?: number;
  /** Max estimated prompt tokens; oldest retrieved messages are dropped to fit. */
  tokenBudget?: number;
};

const DEFAULT_K = 40;
const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * Answer one question for a VERIFIED group id, grounded only in that group's
 * messages.
 *
 * `groupId` MUST come from the resolved inbound JID — it is the privacy boundary
 * (searchMessagesByEmbedding filters on it). This function never resolves a group
 * by name and never takes messages from anywhere else.
 *
 * Returns the grounded refusal string when retrieval finds nothing, so an empty
 * chat can't produce a hallucinated answer.
 */
export async function answerQuestion(
  deps: AnswerDeps,
  input: { groupId: number; question: string },
): Promise<string> {
  const k = deps.retrieveK ?? DEFAULT_K;
  const budget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  const queryEmbedding = await deps.embedder.embed(input.question);
  const retrieved = await searchMessagesHybrid(
    deps.pool,
    input.groupId,
    { embedding: queryEmbedding, text: input.question },
    k,
  );
  if (retrieved.length === 0) {
    // Empty means this group has NO embedded content messages — i.e. it isn't
    // indexed yet, an operational state — NOT that the answer wasn't discussed.
    // Say so honestly instead of falsely claiming "not in the chat".
    return NOT_INDEXED;
  }

  const context = fitToBudget(input.question, retrieved, budget);
  const answer = await deps.llm.answer(buildAskPrompt(input.question, context));
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : NOT_IN_CHAT;
}

/**
 * Drop the OLDEST retrieved messages until the prompt fits `budget`. Retrieval
 * returns messages chronologically; the most recent are usually the most
 * relevant to a "did we…?" question, so recency is the tiebreak when trimming.
 * Always keeps at least one message.
 */
function fitToBudget(
  question: string,
  messages: AskContextMessage[],
  budget: number,
): AskContextMessage[] {
  let ctx = messages;
  while (ctx.length > 1) {
    const p = buildAskPrompt(question, ctx);
    if (estimateTokens(p.system + p.user) <= budget) break;
    ctx = ctx.slice(1); // drop the oldest
  }
  return ctx;
}
