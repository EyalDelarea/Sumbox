import type pg from "pg";
import { toVectorLiteral } from "../vector.js";

/**
 * Repository for `message_embeddings` — the bge-m3 vectors that power the `ask`
 * (@Aida) feature's semantic retrieval.
 *
 * ── PRIVACY (load-bearing) ───────────────────────────────────────────────────
 * `searchMessagesByEmbedding` is ALWAYS scoped by `group_id` in the SQL. The
 * caller passes a group id it resolved from the VERIFIED inbound JID (never a
 * name lookup), so a group's messages can never surface in another chat. The
 * `message-embeddings.test.ts` cross-group test is the permanent guard on this.
 */

/**
 * The canonical "content-bearing message" expression — identical to
 * summarization/select.ts, so embeddings cover exactly what a summary would read:
 * the text, plus a completed transcript (voice notes) or media description
 * (images/video). Kept in sync by copy because select.ts owns the summary path
 * and this owns the retrieval path; a drift between them would embed different
 * text than the reader sees.
 *
 * ── Editing this expression now costs a full re-embed ────────────────────────
 * Embeddings are keyed to it by `message_embeddings.content_hash`, which hashes
 * this expression's RESULT. So reformatting the SQL is free, but any change to
 * the text it produces — the ' — ' separator, the trim/NULLIF semantics, which
 * columns are concatenated — re-hashes every message, and the sweep re-derives
 * the whole corpus (hours on the single local GPU). That is correct: this formula
 * defines what a vector MEANS, and a vector built from different text is stale by
 * definition. It just makes such a change a deliberate act with a known cost.
 *
 * The same literal is inlined in the migration that added content_hash (a
 * migration is a historical record and must keep running unchanged). They must
 * agree byte-for-byte, separator included, or the seed hashes the wrong text.
 */
const CONTENT_EXPR = `concat_ws(' — ',
  NULLIF(trim(m.text_content), ''),
  NULLIF(trim(a.description), ''),
  NULLIF(trim(t.transcript), '')
)`;

const CONTENT_JOINS = `
  LEFT JOIN participants p ON p.id = m.participant_id
  LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
  LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
`;

/**
 * Exclude @Aida command messages from RETRIEVAL. Like the summary path drops the
 * /סיכום trigger, an "@אידה …" message is a command, not conversation — and the
 * triggering question would otherwise retrieve ITSELF as context (self-reference
 * noise that dilutes the real signal). Case-insensitive, both scripts.
 */
const EXCLUDE_ASK_MENTION = `AND coalesce(m.text_content, '') !~* '@(אידה|aida)'`;

export type PendingEmbedding = { id: number; content: string; contentHash: string };

/**
 * Content-bearing messages whose embedding is missing or STALE, newest first.
 *
 * Newest-first so a fresh backfill/sweep makes RECENT history searchable soonest
 * — that is what an @Aida question most often needs. Drives the one-time catch-up,
 * the ongoing sweep of new messages, AND the re-embed of enriched ones; one query,
 * one mechanism.
 *
 * ── Why the hash (do not swap it for a timestamp) ────────────────────────────
 * A captioned photo has non-empty content at ingest, so it gets embedded on the
 * caption alone; the vision description lands minutes later. The old predicate
 * (`e.message_id IS NULL`) never looked at an already-embedded row again, so that
 * vector stayed stale forever — findable by its caption, but not by what was in
 * it.
 *
 * A timestamp comparison (`e.created_at < a.created_at OR e.created_at <
 * t.created_at`) would catch today's cases — insertMediaAnalysis does bump
 * created_at on re-analysis, and insertTranscript is DO NOTHING so a transcript
 * never changes. The hash is chosen anyway because it compares the CONTENT
 * ITSELF rather than a proxy for it: it needs no OR-chain across two nullable
 * joins, does not depend on cross-table clock ordering (now() is transaction
 * time — ties are possible), and it keeps working for a caption edit or any
 * future content source without that writer having to maintain a timestamp.
 *
 * `content_hash IS DISTINCT FROM md5(…)` covers every case in one expression —
 * never embedded (no row → NULL, and NULL IS DISTINCT FROM any hash), late
 * description, late transcript, re-analysis, edited caption.
 *
 * The message_type and `<> ''` guards are INDEPENDENT of the hash arm and must
 * stay: without the non-empty check, an empty or system message with no embedding
 * row would satisfy `NULL IS DISTINCT FROM md5('')` and the sweep would embed
 * empty strings forever.
 */
export async function selectMessagesNeedingEmbedding(
  client: pg.Pool | pg.PoolClient,
  limit: number,
): Promise<PendingEmbedding[]> {
  const res = await client.query<{ id: string; content: string; content_hash: string }>(
    `SELECT m.id, ${CONTENT_EXPR} AS content, md5(${CONTENT_EXPR}) AS content_hash
       FROM messages m
       ${CONTENT_JOINS}
       LEFT JOIN message_embeddings e ON e.message_id = m.id
      WHERE m.message_type <> 'system'
        AND ${CONTENT_EXPR} <> ''
        AND e.content_hash IS DISTINCT FROM md5(${CONTENT_EXPR})
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    content: r.content,
    contentHash: r.content_hash,
  }));
}

/**
 * Store (or refresh) one message's embedding. Idempotent on `message_id` (unique
 * constraint) so re-running the sweep or a re-embed never duplicates or errors.
 *
 * ── CONVERGENCE INVARIANT (load-bearing) ─────────────────────────────────────
 * `contentHash` MUST be the hash that {@link selectMessagesNeedingEmbedding}
 * computed and handed back — never one recomputed here or in JS. The select's
 * WHERE and this write must agree byte-for-byte; if they ever disagree (JS vs
 * Postgres md5, separator or unicode-normalization differences), every enriched
 * message re-selects on EVERY sweep forever — a silent busy-loop that pins the
 * local GPU and merely looks like "the sweep is always working".
 * `embedding-sweep.test.ts` asserts convergence: sweep to completion, then the
 * next select returns nothing.
 */
export async function upsertMessageEmbedding(
  client: pg.Pool | pg.PoolClient,
  input: { messageId: number; embedding: number[]; model: string; contentHash: string },
): Promise<void> {
  await client.query(
    `INSERT INTO message_embeddings (message_id, embedding, model, content_hash)
     VALUES ($1, $2::vector, $3, $4)
     ON CONFLICT (message_id)
     DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
                   content_hash = EXCLUDED.content_hash, created_at = now()`,
    [input.messageId, toVectorLiteral(input.embedding), input.model, input.contentHash],
  );
}

export type RetrievedMessage = {
  messageId: number;
  sentAt: Date;
  sender: string;
  content: string;
};

/**
 * The `k` messages of THIS group most semantically similar to `queryEmbedding`,
 * by cosine distance (`<=>`), returned in RANK order (best first) so the caller
 * can fuse it with the lexical ranking. @Aida command messages are excluded.
 *
 * The `WHERE m.group_id = $1` is the privacy boundary — do not remove it, and do
 * not add an entry point that searches without a group id.
 */
export async function searchMessagesByEmbedding(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  queryEmbedding: number[],
  k: number,
): Promise<RetrievedMessage[]> {
  const res = await client.query<{
    id: string;
    sent_at: Date;
    sender: string;
    content: string;
  }>(
    `SELECT m.id,
            m.sent_at,
            COALESCE(p.display_name, 'Unknown') AS sender,
            ${CONTENT_EXPR} AS content
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       ${CONTENT_JOINS}
      WHERE m.group_id = $1
        AND m.message_type <> 'system'
        ${EXCLUDE_ASK_MENTION}
        AND ${CONTENT_EXPR} <> ''
      ORDER BY e.embedding <=> $2::vector
      LIMIT $3`,
    [groupId, toVectorLiteral(queryEmbedding), k],
  );
  return res.rows.map((r) => ({
    messageId: Number(r.id),
    sentAt: r.sent_at,
    sender: r.sender,
    content: r.content,
  }));
}

/**
 * Lexical (keyword) retrieval for THIS group, ranked by `ts_rank`. Uses the
 * existing `messages_text_fts_idx` GIN index over `to_tsvector('simple',
 * text_content)`, so it matches exact tokens the semantic ranker can miss
 * (names, numbers, addresses). `websearch_to_tsquery` is input-safe — it never
 * throws on odd user text, it just yields fewer/zero matches.
 *
 * NOTE: the FTS index covers `text_content` only, not transcripts/descriptions,
 * so lexical recall is text-message-only; the semantic search covers the rest.
 * Same `WHERE m.group_id = $1` privacy boundary. Returned in RANK order (best
 * first) so the caller can fuse it with the semantic ranking.
 */
export async function searchMessagesLexical(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  queryText: string,
  limit: number,
): Promise<RetrievedMessage[]> {
  // OR the query's words, not AND. websearch/plainto_tsquery AND every term, so
  // "כמה משולשים" would require BOTH — but a message that says only "משולשים" is
  // exactly the exact-keyword hit we want. So build the query for the strict
  // `to_tsquery` and join the terms with `|` (OR). `to_tsquery` DOES raise on
  // malformed syntax — the safety here comes from the tokenization below, NOT the
  // function: `[\p{L}\p{N}]+` keeps only alphanumeric runs (any script), stripping
  // every tsquery operator, so the terms can never form invalid syntax or inject.
  // ts_rank still orders by how well each row matches, so more overlap ranks higher.
  const tokens = queryText.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return []; // nothing lexical to search
  const tsquery = [...new Set(tokens)].join(" | ");

  const res = await client.query<{
    id: string;
    sent_at: Date;
    sender: string;
    content: string;
  }>(
    `SELECT m.id,
            m.sent_at,
            COALESCE(p.display_name, 'Unknown') AS sender,
            ${CONTENT_EXPR} AS content
       FROM messages m
       ${CONTENT_JOINS}
       , to_tsquery('simple', $2) q
      WHERE m.group_id = $1
        AND m.message_type <> 'system'
        ${EXCLUDE_ASK_MENTION}
        AND to_tsvector('simple', coalesce(m.text_content, '')) @@ q
        AND ${CONTENT_EXPR} <> ''
      ORDER BY ts_rank(to_tsvector('simple', coalesce(m.text_content, '')), q) DESC,
               m.sent_at DESC
      LIMIT $3`,
    [groupId, tsquery, limit],
  );
  return res.rows.map((r) => ({
    messageId: Number(r.id),
    sentAt: r.sent_at,
    sender: r.sender,
    content: r.content,
  }));
}
