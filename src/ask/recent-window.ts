/**
 * recent-window.ts — the last N messages of the group, verbatim.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Search answers "what was said about X". It cannot answer "what just happened",
 * because a question like "did anyone just ask me something?" shares no terms
 * with the message that answers it. Measured on the real corpus: hit rate 0.00
 * across the fused, semantic AND lexical arms for exactly those questions —
 * both arms are blind, so this is not a ranking problem that better fusion fixes.
 *
 * It reads raw `messages`, so it needs NO embeddings. That matters more than it
 * looks: the embedding sweep died for ~50 minutes on 2026-07-16 and @Aida
 * silently degraded to lexical-only. The window keeps working through that.
 *
 * ── Necessary, NOT sufficient ────────────────────────────────────────────────
 * Putting the message in front of her does not make her use it: with the gold
 * already in context, gemma4 still denied at 67–100% (spike, 2026-07-16). The
 * window closes the retrieval half of the bug; the generation half is a separate
 * problem measured by suite-e's false_denial_generation.
 */

import type pg from "pg";
import type { RetrievedMessage } from "../db/repositories/message-embeddings.js";
import { CONTENT_EXPR, CONTENT_JOINS } from "../db/repositories/message-embeddings.js";

/** A window message, plus who wrote it. */
export type WindowMessage = RetrievedMessage & {
  /** True when @Aida sent it — so her turns can be rendered as hers, not as the owner's. */
  isAida: boolean;
};

/**
 * The last `n` messages at or before `asOf`, oldest-first.
 *
 * `asOf` is an explicit input, never `now()`. It is the triggering message's
 * sent_at — the conversational "now". Three reasons this must be a parameter:
 * a reply arriving seconds later must not shift the window; the eval harness has
 * to replay a historical moment exactly; and pinning a corpus ceiling is what
 * keeps eval numbers comparable as the live DB grows.
 *
 * Content extraction reuses CONTENT_EXPR/CONTENT_JOINS so a media caption or
 * transcript reads identically here and in search.
 *
 * @param excludeExternalId - the triggering message itself; it is the question,
 *   not context, and echoing it back wastes budget and invites her to answer it twice.
 */
export async function selectRecentMessages(
  client: pg.Pool | pg.PoolClient,
  input: {
    groupId: number;
    n: number;
    asOf: Date;
    excludeExternalId?: string;
  },
): Promise<WindowMessage[]> {
  const { rows } = await client.query<{
    id: string;
    sent_at: Date;
    sender: string | null;
    content: string;
    is_aida: boolean;
  }>(
    `SELECT m.id,
            m.sent_at,
            p.display_name AS sender,
            ${CONTENT_EXPR} AS content,
            (am.external_id IS NOT NULL) AS is_aida
       FROM messages m
       ${CONTENT_JOINS}
       LEFT JOIN aida_messages am
              ON am.group_id = m.group_id AND am.external_id = m.external_id
      WHERE m.group_id = $1
        AND m.sent_at <= $2
        AND m.message_type <> 'system'
        AND ${CONTENT_EXPR} <> ''
        AND ($4::text IS NULL OR m.external_id IS DISTINCT FROM $4::text)
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT $3`,
    [input.groupId, input.asOf, input.n, input.excludeExternalId ?? null],
  );

  // Fetched newest-first (that is what LIMIT must select), returned oldest-first
  // so the prompt reads as a transcript.
  return rows
    .map((r) => ({
      messageId: Number(r.id),
      sentAt: r.sent_at,
      sender: r.sender ?? "",
      content: r.content,
      isAida: r.is_aida,
    }))
    .reverse();
}
