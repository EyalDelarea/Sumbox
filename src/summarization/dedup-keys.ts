/**
 * Content-identity keys for the dedup canonical store (spec 021 / issue #16 #5).
 *
 * Pure, deterministic normalization so the same commitment expressed in
 * different words/order/punctuation collapses to one key. These are the bottom
 * layer of the dedup spine — no DB, no behavior — consumed by the dedup-aware
 * upserts in a later PR. Hebrew-first: niqqud and punctuation are stripped and
 * matching is order-independent (token-set), since Hebrew commitment phrasing
 * varies word order freely ("לשלוח לרונית מחיר" ≡ "מחיר לרונית לשלוח").
 */

// Standalone filler words that carry no intent — dropped before keying. Kept
// deliberately small (only whole-word tokens, never letter-prefixes, which in
// Hebrew attach to the next word and can't be split safely).
const STOPWORDS = new Set([
  // Hebrew
  "את",
  "של",
  "על",
  "עם",
  "אל",
  "אני",
  "אתה",
  "זה",
  "זאת",
  "יש",
  "אין",
  "גם",
  "כדי",
  "כי",
  "אבל",
  "או",
  // English
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "and",
  "or",
]);

/**
 * Lowercase, strip Hebrew niqqud/cantillation, drop punctuation/emoji, collapse
 * whitespace. The shared base for every key below. Never throws.
 */
export function normalizeText(input: string | null | undefined): string {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(/[֑-ׇ]/g, "") // Hebrew niqqud + cantillation marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation, emoji → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize normalized text into content words (stopwords removed). */
function contentTokens(input: string | null | undefined): string[] {
  const norm = normalizeText(input);
  if (!norm) return [];
  return norm.split(" ").filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Order-independent intent key for task/commitment dedup within a chat:
 * sorted, de-duplicated content tokens. Empty input → "". Two tasks with the
 * same key are the same commitment regardless of word order or filler.
 */
export function intentKey(text: string | null | undefined): string {
  return [...new Set(contentTokens(text))].sort().join(" ");
}

/**
 * Topic key for meeting similarity — the normalized content-token string in
 * sorted-set form (same treatment as {@link intentKey}). Compare two topicKeys
 * for equality, or token-overlap for fuzzy similarity, in the matcher.
 */
export function topicKey(text: string | null | undefined): string {
  return intentKey(text);
}

/**
 * Order-independent participant-set key for meeting dedup: normalized, unique,
 * sorted display names joined with "|". Falsy/blank names are dropped. The same
 * group of people always produces the same key regardless of listing order.
 */
export function participantSetKey(names: ReadonlyArray<string | null | undefined>): string {
  const set = new Set<string>();
  for (const n of names) {
    const norm = normalizeText(n);
    if (norm) set.add(norm);
  }
  return [...set].sort().join("|");
}

/**
 * Jaccard token-overlap of two intent/topic keys, in [0,1]. 1 = identical sets,
 * 0 = disjoint (or either empty). The matcher uses this for the fuzzy threshold
 * (e.g. merge meetings when topic overlap ≥ 0.6) rather than exact key equality.
 */
export function keyOverlap(a: string, b: string): number {
  const sa = new Set(a ? a.split(" ") : []);
  const sb = new Set(b ? b.split(" ") : []);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
