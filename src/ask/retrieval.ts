import type pg from "pg";
import {
  type RetrievedMessage,
  searchMessagesByEmbedding,
  searchMessagesLexical,
} from "../db/repositories/message-embeddings.js";
import { rrfFuse } from "./rrf.js";

/**
 * Hybrid retrieval for @Aida: fuse semantic (pgvector) and lexical (FTS)
 * rankings of THIS group's messages via Reciprocal Rank Fusion.
 *
 * Semantic catches paraphrase; lexical catches the exact token semantic ranking
 * buries (a name, a number, "משולשים"). Fusing rewards messages BOTH agree on.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * Both sub-searches filter `WHERE group_id = <verified id>`; fusion only reorders
 * ids that already came from this group. The hybrid can never widen scope.
 *
 * Returns up to `k` messages in CHRONOLOGICAL order (reads as a mini-transcript
 * for the model). Degrades to semantic-only when the lexical query matches
 * nothing (e.g. a cross-language question), so it is never worse than semantic.
 */
export async function searchMessagesHybrid(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  query: { embedding: number[]; text: string },
  k: number,
): Promise<RetrievedMessage[]> {
  const [semantic, lexical] = await Promise.all([
    searchMessagesByEmbedding(client, groupId, query.embedding, k),
    searchMessagesLexical(client, groupId, query.text, k),
  ]);

  // Union of full rows by id, so a fused id can be hydrated from whichever
  // search found it (both filtered to this group, so no foreign row can enter).
  const byId = new Map<number, RetrievedMessage>();
  for (const m of semantic) byId.set(m.messageId, m);
  for (const m of lexical) if (!byId.has(m.messageId)) byId.set(m.messageId, m);

  const fusedIds = rrfFuse([
    semantic.map((m) => m.messageId),
    lexical.map((m) => m.messageId),
  ]).slice(0, k);

  return fusedIds
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}
