import { tool } from "ai";
import type pg from "pg";
import { z } from "zod";
import { resolveSenderName } from "../summarization/sender-name.js";
import type { Embedder } from "./embedder.js";
import { fenceRetrieved, neutralizeFence } from "./prompt.js";
import { searchMessagesHybrid } from "./retrieval.js";

/** The one Slice-1 tool: search THIS group's history. groupId + the original
 *  question are captured by CLOSURE — the model cannot change the group, and the
 *  question is fused into the embedding so a narrow model query can't underperform
 *  the single-shot search. */
export function makeSearchChatTool(deps: {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  groupId: number;
  question: string;
  /**
   * Probe: every message id this tool surfaced, in rank order, once per call.
   *
   * Exists for the eval harness, which must separate "she never saw the message"
   * (retrieval) from "she saw it and denied anyway" (generation) — the two halves
   * of the false-denial metric. Without it, an end-to-end run can only observe
   * that she refused, not why, and the bug is unattributable.
   *
   * Optional and side-effect-only: prod passes nothing and behaviour is unchanged.
   */
  onRetrieved?: (messageIds: number[]) => void;
}) {
  return tool({
    description:
      "Search THIS WhatsApp group's message history for messages relevant to a query. Returns matching messages.",
    inputSchema: z.object({ query: z.string().describe("what to search for, in Hebrew") }).strict(),
    execute: async ({ query }) => {
      const embedding = await deps.embedder.embed(`${deps.question} ${query}`);
      const hits = await searchMessagesHybrid(
        deps.pool,
        deps.groupId,
        { embedding, text: query },
        8,
      );
      // Report BEFORE the empty-hits bail: "searched and found nothing" and
      // "never searched" are different bugs, and the probe must distinguish them.
      deps.onRetrieved?.(hits.map((h) => h.messageId));
      if (hits.length === 0) return "(no matching messages)";
      const lines = hits.map(
        (h) => `${neutralizeFence(resolveSenderName(h.sender))}: ${neutralizeFence(h.content)}`,
      );
      return fenceRetrieved(lines);
    },
  });
}
