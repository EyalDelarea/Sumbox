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

export type UnembeddedMessage = { id: number; content: string };

/**
 * Content-bearing messages that have no embedding row yet, newest first.
 *
 * Newest-first so a fresh backfill/sweep makes RECENT history searchable soonest
 * — that is what an @Aida question most often needs. Drives both the one-time
 * catch-up of the stale historical gap and the ongoing sweep of new messages;
 * one query, one mechanism.
 */
export async function selectUnembeddedContentMessages(
  client: pg.Pool | pg.PoolClient,
  limit: number,
): Promise<UnembeddedMessage[]> {
  const res = await client.query<{ id: string; content: string }>(
    `SELECT m.id, ${CONTENT_EXPR} AS content
       FROM messages m
       ${CONTENT_JOINS}
       LEFT JOIN message_embeddings e ON e.message_id = m.id
      WHERE e.message_id IS NULL
        AND m.message_type <> 'system'
        AND ${CONTENT_EXPR} <> ''
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: Number(r.id), content: r.content }));
}

/**
 * Store (or refresh) one message's embedding. Idempotent on `message_id` (unique
 * constraint) so re-running the sweep or a re-embed never duplicates or errors.
 */
export async function upsertMessageEmbedding(
  client: pg.Pool | pg.PoolClient,
  input: { messageId: number; embedding: number[]; model: string },
): Promise<void> {
  await client.query(
    `INSERT INTO message_embeddings (message_id, embedding, model)
     VALUES ($1, $2::vector, $3)
     ON CONFLICT (message_id)
     DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = now()`,
    [input.messageId, toVectorLiteral(input.embedding), input.model],
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
 * by cosine distance (`<=>`), returned in chronological order so the model reads
 * them as a mini-transcript.
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
        AND ${CONTENT_EXPR} <> ''
      ORDER BY e.embedding <=> $2::vector
      LIMIT $3`,
    [groupId, toVectorLiteral(queryEmbedding), k],
  );
  return res.rows
    .map((r) => ({
      messageId: Number(r.id),
      sentAt: r.sent_at,
      sender: r.sender,
      content: r.content,
    }))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}
