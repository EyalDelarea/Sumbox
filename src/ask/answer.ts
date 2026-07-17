import type pg from "pg";
import { estimateTokens } from "../summarization/prompt.js";
import { type CitedAnswer, extractCitations } from "./citations.js";
import type { Embedder } from "./embedder.js";
import {
  type AskContextMessage,
  type AskPrompt,
  type AskWindowMessage,
  buildAskPrompt,
  NOT_IN_CHAT,
  NOT_INDEXED,
} from "./prompt.js";
import { selectRecentMessages } from "./recent-window.js";
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
  /** How many recent messages to always show. Default 20. */
  windowN?: number;
};

const DEFAULT_K = 40;
const DEFAULT_TOKEN_BUDGET = 8000;
/** Enough to cover a live exchange without crowding out search hits. */
const DEFAULT_WINDOW_N = 20;

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
  input: { groupId: number; question: string; asOf?: Date; excludeExternalId?: string },
): Promise<CitedAnswer> {
  const k = deps.retrieveK ?? DEFAULT_K;
  const budget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const windowN = deps.windowN ?? DEFAULT_WINDOW_N;

  const queryEmbedding = await deps.embedder.embed(input.question);
  const [retrieved, window] = await Promise.all([
    searchMessagesHybrid(
      deps.pool,
      input.groupId,
      { embedding: queryEmbedding, text: input.question },
      k,
    ),
    selectRecentMessages(deps.pool, {
      groupId: input.groupId,
      n: windowN,
      // The trigger's sent_at is the conversational "now"; default to wall-clock
      // only when a caller has none to give.
      asOf: input.asOf ?? new Date(),
      ...(input.excludeExternalId ? { excludeExternalId: input.excludeExternalId } : {}),
    }),
  ]);

  // NOT_INDEXED means the group has no embedded content — an operational state,
  // not "it wasn't discussed". But the window reads raw messages, so if it has
  // anything we can still answer honestly from what is right there; claiming "no
  // access" while holding the last 20 messages would be its own false statement.
  if (retrieved.length === 0 && window.length === 0) return { text: NOT_INDEXED, citedIds: [] };

  // Search hits already in the window would be rendered twice — wasted budget,
  // and duplicate evidence reads as corroboration to the model.
  const windowIds = new Set(window.map((m) => m.messageId));
  const deduped = retrieved.filter((m) => !windowIds.has(m.messageId));

  const context = fitToBudget(input.question, deduped, budget, window);
  const answer = await deps.llm.answer(buildAskPrompt(input.question, context, window));
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { text: NOT_IN_CHAT, citedIds: [] };

  // Exactly what the fence rendered — the window plus the budget-TRIMMED context,
  // not the full retrieved set. An id trimmed out was never shown to her, so
  // accepting it would defeat the point of validating at all.
  const shown = new Set<number>([
    ...window.map((m) => m.messageId),
    ...context.map((m) => m.messageId),
  ]);
  return extractCitations(trimmed, shown);
}

/**
 * Drop the OLDEST retrieved messages until the prompt fits `budget`. Retrieval
 * returns messages chronologically; the most recent are usually the most
 * relevant to a "did we…?" question, so recency is the tiebreak when trimming.
 * Always keeps at least one message.
 *
 * The window is PINNED: it is passed through for measurement but never trimmed.
 * Trimming it would evict the only thing that can answer "what just happened" —
 * the exact bug the window exists to fix — and would do so silently, on precisely
 * the long conversations where recency matters most.
 */
function fitToBudget(
  question: string,
  messages: AskContextMessage[],
  budget: number,
  window: AskWindowMessage[] = [],
): AskContextMessage[] {
  let ctx = messages;
  while (ctx.length > 1) {
    const p = buildAskPrompt(question, ctx, window);
    if (estimateTokens(p.system + p.user) <= budget) break;
    ctx = ctx.slice(1); // drop the oldest SEARCH hit; never the window
  }
  return ctx;
}
