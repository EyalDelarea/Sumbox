/**
 * citations.ts — pull @Aida's [msg:N] citations out of her reply, and hand back
 * text that is safe to send.
 *
 * The fence shows her `[msg:N]` on every message (see prompt.ts citeTag); she
 * cites the ids a claim rests on. The tags are a routing signal for the caller,
 * never something the group should see — so extraction and stripping are one
 * operation, and the only text that leaves here is already clean.
 *
 * Trust model: an id is worth acting on ONLY if we showed it to her. Everything
 * else is dropped silently. A citation is best-effort throughout — losing one
 * costs the source pin, never the answer.
 */

import { NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC } from "./prompt.js";

/** Her reply, split into what the group sees and what the caller routes on. */
export type CitedAnswer = {
  /** Send-ready: tags removed, spacing repaired. */
  text: string;
  /**
   * The ids she cited that we actually showed her, first-seen order, deduped.
   * Empty when she cited nothing, cited only unknown ids, or refused.
   */
  citedIds: number[];
};

/**
 * Tags we can PARSE ids out of.
 *
 * Deliberately wider than what citeTag() renders, because the prompt asks for
 * "the message id(s)" and shows one example — so a model with a two-source claim
 * reasonably writes `[msg:101, 102]` or `[msg:101, msg:102]`. Matching only the
 * canonical form would both miss the citation AND ship the tag to the group.
 */
const CITE_RE = /\[\s*msg:\s*\d+(?:\s*,\s*(?:msg:\s*)?\d+)*\s*\]/gi;

/**
 * Anything tag-SHAPED, whether or not we understood it.
 *
 * The safety net: parsing and stripping are separate concerns, and only one of
 * them is allowed to fail. An unparsed variant (a range, a stray space, a format
 * we never imagined) must still never reach the group — leaking internal ids is
 * worse than losing a citation. So we credit only what CITE_RE parses, then
 * strip everything this matches.
 */
const TAG_SHAPED_RE = /\[\s*msg\b[^\]]*\]/gi;

/**
 * The exact strings the prompt tells her to use when she has no answer.
 *
 * A refusal that cites a message contradicts itself — it would quote the very
 * message it claims not to have found — so a tag riding along on one is noise.
 */
const REFUSALS = [NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC];

/**
 * Repair the spacing a removed tag leaves behind.
 *
 * `אמר [msg:101] שזה` → `אמר  שזה`, and a trailing tag before a full stop leaves
 * ` .`. Hebrew is RTL but the whitespace is ordinary, so this is plain text
 * cleanup — it just has to be done, or her reply arrives visibly damaged.
 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?…:;])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split `raw` into send-ready text plus the ids she cited.
 *
 * `validIds` is everything the fence showed her for this question — the window,
 * the pre-seeded hits, and anything search_chat returned. An id outside it is
 * either a hallucination or a message we can no longer resolve; both are dropped.
 */
export function extractCitations(raw: string, validIds: ReadonlySet<number>): CitedAnswer {
  const cited: number[] = [];
  const seen = new Set<number>();

  for (const tag of raw.matchAll(CITE_RE)) {
    // One tag may carry several ids ("[msg:101, 102]"); each is a separate cite.
    for (const digits of tag[0].matchAll(/\d+/g)) {
      const id = Number(digits[0]);
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      cited.push(id);
    }
  }

  // Strip tag-SHAPED text, not just what parsed — see TAG_SHAPED_RE.
  const text = tidy(raw.replace(TAG_SHAPED_RE, " "));
  // Strip first, judge second: a refusal must still lose its tags before send.
  const refused = REFUSALS.some((r) => text.includes(r));

  return { text, citedIds: refused ? [] : cited };
}
