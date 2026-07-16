/**
 * golden.ts — the golden set: schema, loader, and the corpus-pinning rules.
 *
 * ── Why items are ASSERTIONS, not expected answers ───────────────────────────
 * Free-form Hebrew has unbounded valid phrasings, so an expected-answer string is
 * useless (exact match never fires) and fuzzy similarity is a lie (it scores
 * prose, not correctness). Items instead assert *facts and ids*: which message
 * must be retrieved, whether a refusal is allowed, which tool must run. Those are
 * stable as @Aida's phrasing evolves, and — because ids are integers — immune to
 * the Hebrew morphology problems that plague substring assertions.
 *
 * ── Why external_id and not messages.id ──────────────────────────────────────
 * The corpus is a LIVE WhatsApp DB: the ground truth moves under the golden set.
 * Local `messages.id` is a serial that changes on re-import; `external_id` is
 * WhatsApp's own id and survives. An item keyed on a serial silently rots into
 * "recall dropped" when nothing regressed at all.
 *
 * ── Why the file is gitignored ───────────────────────────────────────────────
 * Items quote real group messages. Committing them to GitHub *is* message content
 * leaving the device — the one constraint GOVERNANCE calls absolute. The local
 * Langfuse dataset is the source of truth; the JSONL is a local, diffable mirror.
 * The red-team probes (src/ops/ask-redteam.ts) are synthetic and stay committed.
 */

import { readFileSync } from "node:fs";

/**
 * A slice tag. Report per-slice and gate on the recency slice specifically: an
 * aggregate hides a collapse in `<1h` behind healthy items, which is exactly
 * where the false-denial bug lives.
 */
export type Slice = string;

export type GoldenItem = {
  /** Stable, human-meaningful key. Also the Langfuse dataset item id. */
  id: string;
  /** The group this item is grounded in. The privacy boundary for retrieval. */
  groupId: number;
  /** Exactly what a user would send, MINUS the @אידה tag (matchAskTrigger strips it). */
  question: string;
  /**
   * WhatsApp external_ids that answer the question. Empty means D_absent — the
   * answer genuinely is NOT in the chat and a refusal is CORRECT.
   */
  goldExternalIds: string[];
  /**
   * false for D_absent items. Pairing must_not_refuse items with D_absent ones is
   * not optional: driving the denial rate down without a correct-denial slice just
   * trains her to hallucinate agreement. The two move together or the metric lies.
   */
  mustNotRefuse: boolean;
  /** Tools the agentic loop must have called. A denial with zero tool calls is a distinct bug. */
  expectedToolCalls?: string[];
  slice: Slice[];
  provenance: { added: string; reason: string; traceId?: string };
};

/**
 * The corpus ceiling for a run. Every item is evaluated as if "now" were this
 * instant, so a growing corpus cannot silently move the numbers between runs.
 * Same mechanism as the recency window's `asOf` anchor — one concept, two jobs.
 */
export type CorpusPin = { asOf: Date };

/** Parse JSONL (one item per line; blank lines and `#` comments ignored). */
export function parseGolden(text: string): GoldenItem[] {
  const items: GoldenItem[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`golden set line ${i + 1}: invalid JSON — ${(err as Error).message}`);
    }
    items.push(validate(parsed, i + 1));
  }
  return items;
}

export function loadGolden(path: string): GoldenItem[] {
  return parseGolden(readFileSync(path, "utf8"));
}

/**
 * Validate eagerly and loudly. A malformed item that loads as `undefined` would
 * silently drop an assertion — the harness would report a green run over fewer
 * checks than it claims, which is worse than no harness at all.
 */
function validate(v: unknown, line: number): GoldenItem {
  const o = v as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new Error(`golden set line ${line}: ${msg}`);
  };
  if (typeof o["id"] !== "string" || !o["id"]) fail("`id` must be a non-empty string");
  if (typeof o["groupId"] !== "number") fail("`groupId` must be a number");
  if (typeof o["question"] !== "string" || !o["question"]) fail("`question` must be non-empty");
  if (!Array.isArray(o["goldExternalIds"])) fail("`goldExternalIds` must be an array");
  if (typeof o["mustNotRefuse"] !== "boolean") fail("`mustNotRefuse` must be a boolean");
  if (!Array.isArray(o["slice"]) || o["slice"].length === 0) fail("`slice` must be non-empty");

  const gold = o["goldExternalIds"] as string[];
  const mustNotRefuse = o["mustNotRefuse"] as boolean;
  // The one cross-field invariant: an item cannot demand an answer while naming
  // no evidence that would support one. That combination is unprovable by
  // construction and would score as a permanent, unfixable failure.
  if (mustNotRefuse && gold.length === 0) {
    fail("`mustNotRefuse: true` requires at least one goldExternalId (else it is unprovable)");
  }
  return o as unknown as GoldenItem;
}

/** Items whose ground truth is "this IS in the chat" — the false-denial slice. */
export function presentItems(items: GoldenItem[]): GoldenItem[] {
  return items.filter((i) => i.goldExternalIds.length > 0);
}

/** D_absent: the answer genuinely is not in the chat, so refusing is CORRECT. */
export function absentItems(items: GoldenItem[]): GoldenItem[] {
  return items.filter((i) => i.goldExternalIds.length === 0);
}
