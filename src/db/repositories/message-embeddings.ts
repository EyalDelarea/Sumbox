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
/**
 * Exported for the recency window (ask/recent-window.ts), which MUST extract
 * content identically to the embed/search path — otherwise a media caption or a
 * transcript would be visible to search but invisible in the window (or vice
 * versa), and the two views of the same message would silently disagree.
 */
export const CONTENT_EXPR = `concat_ws(' — ',
  NULLIF(trim(m.text_content), ''),
  NULLIF(trim(a.description), ''),
  NULLIF(trim(t.transcript), '')
)`;

/** @see CONTENT_EXPR — the joins it depends on. */
export const CONTENT_JOINS = `
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
  /**
   * True when @Aida herself sent it (per the aida_messages marker). Carried so
   * attribution can refuse to cite her own replies: an echo of someone's words
   * matches the new answer at least as well as the original, and pinning the
   * echo would credit the words to the owner's account. Optional because some
   * constructors of this shape (tests, older callers) don't know.
   */
  isAida?: boolean;
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
    is_aida: boolean;
  }>(
    `SELECT m.id,
            m.sent_at,
            COALESCE(p.display_name, 'Unknown') AS sender,
            ${CONTENT_EXPR} AS content,
            (am.external_id IS NOT NULL) AS is_aida
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       ${CONTENT_JOINS}
       LEFT JOIN aida_messages am
              ON am.group_id = m.group_id AND am.external_id = m.external_id
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
    isAida: r.is_aida,
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
/**
 * Hebrew clitic prefixes, in the only order they can stack: ו (and), then
 * ש (that), then one of ב/כ/ל/מ (in/as/to/from), then ה (the) — "ושהליינאפ".
 * Each class appears at most once, so a matching letter INSIDE the word can't
 * trigger a second strip from the same class ("ליינאפ" must not lose its ל
 * after the article was already peeled off "הליינאפ").
 */
const PREFIX_STACK = [/^ו/, /^ש/, /^[בכלמ]/, /^ה/];
/** Never strip down past this — two-letter stumps match half the chat. */
const MIN_STEM = 3;

/**
 * A query token plus its de-prefixed Hebrew variants, original first.
 *
 * The 'simple' FTS config knows nothing about Hebrew morphology, so "הליינאפ"
 * and "ליינאפ" are unrelated tokens to it — and question phrasing adds the
 * definite article almost by default ("מה רועי אמר על הליינאפ?" vs his
 * "ליינאפ"). Measured live 2026-07-18: that exact mismatch made lexical search
 * return nothing and @Aida deny a message that existed.
 *
 * Expanding the QUERY side is deliberate: it needs no migration and no reindex.
 * The cost is over-stripping ("מחשבה" also searches "חשבה"), which is harmless
 * here — these are OR terms in a RANKED list fused by RRF, so a bogus variant
 * adds candidates, never removes them. The reverse direction (message has the
 * prefix, query doesn't) would need index-side stripping and is NOT covered.
 */
export function lexicalTokenVariants(token: string): string[] {
  const variants = [token];
  let stem = token;
  for (const prefix of PREFIX_STACK) {
    if (!prefix.test(stem)) continue; // classes are optional; order is not
    const stripped = stem.slice(1);
    if (stripped.length < MIN_STEM) break;
    variants.push(stripped);
    stem = stripped;
  }
  return variants;
}

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
  // (Slicing a safe token in lexicalTokenVariants preserves that property.)
  // ts_rank still orders by how well each row matches, so more overlap ranks higher.
  const tokens = queryText.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return []; // nothing lexical to search
  const variants = [...new Set(tokens.flatMap(lexicalTokenVariants))];

  /**
   * Keep only DISTINCTIVE terms — ts_rank has no notion of rarity, and the
   * common words a question is phrased with (מה/על/מי…) match so many messages
   * that they fill the LIMIT and bury the one rare-word hit this search exists
   * to find. Measured live (group 70, 9.1k messages): מה=553, על=364, רועי=176
   * vs ליינאפ=3 — the lineup message never reached the top 40.
   *
   * A term is distinctive when it matches ≤1% of the group's text messages
   * (floor 10, so tiny groups aren't filtered to death). If NOTHING is
   * distinctive the filter falls back to every term — degraded is the old
   * behavior, never an empty search.
   */
  const dfRes = await client.query<{ term: string; df: string; total: string }>(
    `SELECT t.term,
            (SELECT count(*) FROM messages m
              WHERE m.group_id = $1
                AND to_tsvector('simple', coalesce(m.text_content, '')) @@ to_tsquery('simple', t.term)
            ) AS df,
            (SELECT count(*) FROM messages m
              WHERE m.group_id = $1 AND coalesce(m.text_content, '') <> ''
            ) AS total
       FROM unnest($2::text[]) AS t(term)`,
    [groupId, variants],
  );
  const total = Number(dfRes.rows[0]?.total ?? 0);
  const maxDf = Math.max(10, Math.ceil(total * 0.01));
  const rareRows = dfRes.rows.filter((r) => Number(r.df) <= maxDf);
  const kept = rareRows.length > 0 ? rareRows : dfRes.rows;
  const tsquery = kept.map((r) => r.term).join(" | ");

  /**
   * IDF weights for the ORDER BY — the standard fix for "rank has no notion of
   * rarity". ts_rank scores by term frequency only, so a match on אמר (df 37)
   * ties a match on ליינאפ (df 3) and recency decides; with 40+ candidates the
   * rare hit landed at rank 39, where RRF fusion weights it to nearly nothing.
   * ln((total+1)/(df+1)) makes the rarest matched term dominate; sent_at stays
   * as the tiebreak only.
   */
  const terms = kept.map((r) => r.term);
  const weights = kept.map((r) => Math.log((total + 1) / (Number(r.df) + 1)));

  const res = await client.query<{
    id: string;
    sent_at: Date;
    sender: string;
    content: string;
    is_aida: boolean;
  }>(
    `SELECT m.id,
            m.sent_at,
            COALESCE(p.display_name, 'Unknown') AS sender,
            ${CONTENT_EXPR} AS content,
            (am.external_id IS NOT NULL) AS is_aida
       FROM messages m
       ${CONTENT_JOINS}
       LEFT JOIN aida_messages am
              ON am.group_id = m.group_id AND am.external_id = m.external_id
       , to_tsquery('simple', $2) q
      WHERE m.group_id = $1
        AND m.message_type <> 'system'
        ${EXCLUDE_ASK_MENTION}
        AND to_tsvector('simple', coalesce(m.text_content, '')) @@ q
        AND ${CONTENT_EXPR} <> ''
      ORDER BY (SELECT coalesce(sum(tw.w), 0)
                  FROM unnest($4::text[], $5::float8[]) AS tw(term, w)
                 WHERE to_tsvector('simple', coalesce(m.text_content, ''))
                       @@ to_tsquery('simple', tw.term)) DESC,
               m.sent_at DESC
      LIMIT $3`,
    [groupId, tsquery, limit, terms, weights],
  );
  return res.rows.map((r) => ({
    messageId: Number(r.id),
    sentAt: r.sent_at,
    sender: r.sender,
    content: r.content,
    isAida: r.is_aida,
  }));
}
