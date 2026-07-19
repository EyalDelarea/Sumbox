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
import { AUDIO_PREDICATE } from "../db/repositories/transcripts.js";
import { IMAGE_PREDICATE, VIDEO_PREDICATE } from "../vision/media-kind.js";

/** A window message, plus who wrote it. */
export type WindowMessage = RetrievedMessage & {
  /** True when @Aida sent it — so her turns can be rendered as hers, not as the owner's. */
  isAida: boolean;
  /**
   * The kind of unread media still waiting on the analysis/transcription sweep,
   * or `null` once enrichment is done (or the row isn't media at all).
   *
   * Without this, a pending media message used to be INVISIBLE — CONTENT_EXPR
   * resolves to `''` before the sweep completes, so the window silently dropped
   * it (the #45 race: she'd deny seeing a photo that hadn't finished analysis
   * yet). Surfacing the flag lets the prompt render an honest placeholder
   * instead of pretending the message never arrived.
   *
   * Age-bounded to the same 10-minute horizon as the collector's pending-media
   * wait: a permanently-failed analysis (corrupt file, retries exhausted) would
   * otherwise flag forever, rendering "עדיין בניתוח... ask again in a moment" —
   * a promise that never becomes true. Past the horizon the row falls back to
   * today's plain behaviour (invisible if empty) instead of a false promise.
   */
  pendingMedia: "image" | "video" | "voice" | null;
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
    pending_kind: "image" | "video" | "voice" | null;
  }>(
    `SELECT * FROM (
       SELECT m.id, m.sent_at, p.display_name AS sender,
              ${CONTENT_EXPR} AS content,
              (am.external_id IS NOT NULL) AS is_aida,
              CASE
                WHEN m.message_type = 'media' AND m.media_status = 'present'
                     AND (m.media_filename IS NULL OR m.media_filename NOT ILIKE 'STK-%')
                     AND m.sent_at > $2::timestamptz - interval '10 minutes'
                THEN CASE
                  WHEN ${IMAGE_PREDICATE} AND NOT EXISTS (SELECT 1 FROM media_analyses pa
                       WHERE pa.message_id = m.id AND pa.status = 'completed'
                         AND NULLIF(trim(pa.description), '') IS NOT NULL) THEN 'image'
                  WHEN ${VIDEO_PREDICATE} AND NOT EXISTS (SELECT 1 FROM media_analyses pa
                       WHERE pa.message_id = m.id AND pa.status = 'completed'
                         AND NULLIF(trim(pa.description), '') IS NOT NULL) THEN 'video'
                  WHEN ${AUDIO_PREDICATE} AND NOT EXISTS (SELECT 1 FROM transcripts pt
                       WHERE pt.message_id = m.id AND pt.status = 'completed'
                         AND NULLIF(trim(pt.transcript), '') IS NOT NULL) THEN 'voice'
                END
              END AS pending_kind
         FROM messages m
         ${CONTENT_JOINS}
         LEFT JOIN aida_messages am
                ON am.group_id = m.group_id AND am.external_id = m.external_id
        WHERE m.group_id = $1
          AND m.sent_at <= $2
          AND m.message_type <> 'system'
          AND ($4::text IS NULL OR m.external_id IS DISTINCT FROM $4::text)
     ) sub
     WHERE sub.content <> '' OR sub.pending_kind IS NOT NULL
     ORDER BY sub.sent_at DESC, sub.id DESC
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
      pendingMedia: r.pending_kind ?? null,
    }))
    .reverse();
}
