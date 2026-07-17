/**
 * citations.ts — read `[msg:N]` ids out of model output.
 *
 * The single reader of the tag format `citeTag()` writes. Used by attribution.ts
 * to parse the post-hoc matcher's reply.
 *
 * NOTE this does NOT strip tags from anything @Aida says, and does not need to:
 * the answering prompt carries no ids at all (attribution.ts explains why), so
 * she has nothing to copy and no reason to emit one. Tags live only in the
 * attribution pass, whose output is ids for the caller and is never shown to
 * anyone.
 */

/** Her answer, plus the messages it rests on. */
export type CitedAnswer = {
  /** Exactly what the group sees. */
  text: string;
  /**
   * Ids the post-hoc pass matched to `text`, validated against the candidates we
   * offered. Empty when she refused, when nothing matched, or when attribution
   * failed — all of which mean "no source to pin to", never "no answer".
   */
  citedIds: number[];
};

/**
 * Tags we can parse ids out of.
 *
 * Deliberately wider than what `citeTag()` renders: asked for "the id(s)", a
 * model reasonably replies `[msg:101, 102]` or `[msg:101, msg:102]`, and a
 * parser that only understood the canonical form would silently report "no
 * source" for a correct match.
 */
const CITE_RE = /\[\s*msg:\s*\d+(?:\s*,\s*(?:msg:\s*)?\d+)*\s*\]/gi;

/**
 * The ids in `text` that appear in `validIds`, first-seen order, deduped.
 *
 * `validIds` is the candidate set we offered. Anything outside it is invented or
 * unresolvable and is dropped in silence. Order is load-bearing: the first id is
 * the one that gets quoted.
 */
export function parseCitedIds(text: string, validIds: ReadonlySet<number>): number[] {
  const cited: number[] = [];
  const seen = new Set<number>();

  for (const tag of text.matchAll(CITE_RE)) {
    // One tag may carry several ids ("[msg:101, 102]"); each is a separate cite.
    for (const digits of tag[0].matchAll(/\d+/g)) {
      const id = Number(digits[0]);
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      cited.push(id);
    }
  }
  return cited;
}
