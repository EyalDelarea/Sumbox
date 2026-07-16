/**
 * suite-r.ts — retrieval evaluation. No LLM, no judge, seconds to run.
 *
 * This is the suite that makes a real quality gate affordable. Vendor guidance
 * ("block the PR on eval regression") assumes fast hosted APIs; applied to an
 * 11s/question local gemma it produces a flaky 30-minute check, which is the
 * fastest way to get evals switched off. Retrieval, by contrast, is
 * deterministic and embed-only — so the blocking gate belongs HERE, and
 * generation goes nightly.
 *
 * Decoupling retrieval from generation is also what makes a failure
 * attributable: `denial ∧ gold ∉ top-k` indicts retrieval, `denial ∧ gold ∈
 * top-k` indicts generation. Without this split, an end-to-end score tells you
 * something broke but not what.
 *
 * ── Per-arm reporting ────────────────────────────────────────────────────────
 * Metrics are reported for the fused result AND for each arm alone (semantic,
 * lexical). RRF's 1/(k+rank) smoothing can bury a message that one arm ranked
 * #1, so a fused-only number can hide a healthy arm being outvoted. No
 * end-to-end metric catches that; nothing else in the harness will either.
 */

import type pg from "pg";
import type { Embedder } from "../ask/embedder.js";
import { rrfFuse } from "../ask/rrf.js";
import {
  searchMessagesByEmbedding,
  searchMessagesLexical,
} from "../db/repositories/message-embeddings.js";
import type { GoldenItem } from "./golden.js";

/** Which retrieval arm produced a ranking. `fused` is what @Aida actually sees. */
export type Arm = "fused" | "semantic" | "lexical";

export type ArmResult = {
  arm: Arm;
  /** Was at least one gold message retrieved? Binary and brutal — one message answers the question. */
  hit: boolean;
  /** |gold ∩ top-k| / |gold|. */
  recall: number;
  /** 1/rank of the FIRST gold message, else 0. Catches "in the 40 but at rank 38". */
  reciprocalRank: number;
  /** 1-indexed rank of the first gold message, or null. */
  firstGoldRank: number | null;
  retrievedCount: number;
};

export type ItemResult = {
  item: GoldenItem;
  arms: Record<Arm, ArmResult>;
};

export type SuiteRDeps = {
  pool: pg.Pool | pg.PoolClient;
  embedder: Embedder;
  k?: number;
  /** Resolve an item's gold external_ids to local message ids for THIS group. */
  resolveGold?: (groupId: number, externalIds: string[]) => Promise<number[]>;
};

const DEFAULT_K = 40;

/**
 * Map WhatsApp external_ids to local message ids, scoped to the group.
 *
 * Throws when an id resolves to nothing: a golden item pointing at a message
 * that no longer exists is a ROTTED item, not a retrieval failure. Silently
 * treating it as a miss would report a regression that never happened — the
 * exact failure mode external_id keying exists to prevent.
 */
async function defaultResolveGold(
  pool: pg.Pool | pg.PoolClient,
  groupId: number,
  externalIds: string[],
): Promise<number[]> {
  if (externalIds.length === 0) return [];
  const { rows } = await pool.query<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM messages WHERE group_id = $1 AND external_id = ANY($2::text[])`,
    [groupId, externalIds],
  );
  const found = new Set(rows.map((r) => r.external_id));
  const missing = externalIds.filter((e) => !found.has(e));
  if (missing.length > 0) {
    throw new Error(
      `golden item references external_id(s) absent from group ${groupId}: ${missing.join(", ")} — the item has rotted (message purged or re-imported), fix the golden set rather than reading this as a retrieval miss`,
    );
  }
  return rows.map((r) => Number(r.id));
}

function score(arm: Arm, ranked: number[], gold: Set<number>): ArmResult {
  const idx = ranked.findIndex((id) => gold.has(id));
  const found = ranked.filter((id) => gold.has(id)).length;
  return {
    arm,
    hit: idx >= 0,
    // gold.size === 0 (D_absent) has no retrieval target; recall is vacuously 1.
    recall: gold.size === 0 ? 1 : found / gold.size,
    reciprocalRank: idx >= 0 ? 1 / (idx + 1) : 0,
    firstGoldRank: idx >= 0 ? idx + 1 : null,
    retrievedCount: ranked.length,
  };
}

/** Evaluate one item across all three arms. */
export async function evaluateItem(deps: SuiteRDeps, item: GoldenItem): Promise<ItemResult> {
  const k = deps.k ?? DEFAULT_K;
  const resolve = deps.resolveGold ?? ((g, e) => defaultResolveGold(deps.pool, g, e));
  const goldIds = new Set(await resolve(item.groupId, item.goldExternalIds));
  const embedding = await deps.embedder.embed(item.question);

  const [semantic, lexical] = await Promise.all([
    searchMessagesByEmbedding(deps.pool, item.groupId, embedding, k),
    searchMessagesLexical(deps.pool, item.groupId, item.question, k),
  ]);
  const semanticIds = semantic.map((m) => m.messageId);
  const lexicalIds = lexical.map((m) => m.messageId);

  /**
   * Fuse here rather than calling searchMessagesHybrid, because that function
   * re-sorts its result CHRONOLOGICALLY so the prompt reads as a transcript —
   * its array order is not a ranking, and MRR over it would be a number that
   * looks meaningful and is not. rrfFuse is the same primitive the prod path
   * fuses with, so the id SET is identical; only the order differs.
   */
  const fusedIds = rrfFuse([semanticIds, lexicalIds]).slice(0, k);

  return {
    item,
    arms: {
      fused: score("fused", fusedIds, goldIds),
      semantic: score("semantic", semanticIds, goldIds),
      lexical: score("lexical", lexicalIds, goldIds),
    },
  };
}

export type SuiteRSummary = {
  n: number;
  /** Per-arm aggregates over items that HAVE gold (D_absent has no retrieval target). */
  byArm: Record<Arm, { hitRate: number; meanRecall: number; mrr: number }>;
  /** Per-slice hit rate on the fused arm. Gate on the recency slice, not the aggregate. */
  bySlice: Record<string, { n: number; hitRate: number }>;
  results: ItemResult[];
};

/**
 * Run the suite. Only items with gold contribute to retrieval metrics: a
 * D_absent item has nothing to retrieve, and folding its vacuous recall=1 into
 * the mean would inflate the headline number with items that cannot fail.
 */
export async function runSuiteR(deps: SuiteRDeps, items: GoldenItem[]): Promise<SuiteRSummary> {
  const results: ItemResult[] = [];
  for (const item of items) results.push(await evaluateItem(deps, item));

  const scored = results.filter((r) => r.item.goldExternalIds.length > 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const byArm = {} as SuiteRSummary["byArm"];
  for (const arm of ["fused", "semantic", "lexical"] as const) {
    const rs = scored.map((r) => r.arms[arm]);
    byArm[arm] = {
      hitRate: mean(rs.map((r) => (r.hit ? 1 : 0))),
      meanRecall: mean(rs.map((r) => r.recall)),
      mrr: mean(rs.map((r) => r.reciprocalRank)),
    };
  }

  const bySlice: SuiteRSummary["bySlice"] = {};
  for (const r of scored) {
    for (const s of r.item.slice) {
      const cur = bySlice[s] ?? { n: 0, hitRate: 0 };
      const hits = cur.hitRate * cur.n + (r.arms.fused.hit ? 1 : 0);
      bySlice[s] = { n: cur.n + 1, hitRate: hits / (cur.n + 1) };
    }
  }

  return { n: results.length, byArm, bySlice, results };
}
