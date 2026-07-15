/**
 * Detect an @Aida mention and extract the question.
 *
 * Plain-text trigger (no WhatsApp structured mention): a message that contains
 * "@אידה" or "@Aida" (case-insensitive) ANYWHERE fires AIDA. The question is the
 * message with the tag removed. Always-on in enabled groups — no per-message
 * on/off beyond the group allowlist.
 */

// The tag in either script, case-insensitive. The trailing negative lookahead is
// a UNICODE boundary: `\b` is ASCII-only and never fires after a Hebrew letter,
// so it would miss "@אידה " entirely. `(?![\p{L}\p{N}])` instead asserts the tag
// is not glued to another letter/digit — so "@Aidan"/"@אידהלה" don't trigger, but
// punctuation ("@Aida,") and end-of-string do.
const AIDA_TAG = /@(?:אידה|aida)(?![\p{L}\p{N}])/giu;

export type AskMatch = { question: string };

/**
 * Return the extracted question if `text` mentions @Aida, else null.
 * The question is the text minus every tag occurrence, whitespace-collapsed.
 * A mention with no other words (just "@Aida") yields an empty question — the
 * caller decides what to do with that (we answer "what's up"-style from context,
 * but an empty question is still a valid match, not a non-match).
 */
export function matchAskTrigger(text: string): AskMatch | null {
  if (!text) return null;
  AIDA_TAG.lastIndex = 0;
  if (!AIDA_TAG.test(text)) return null;
  const question = text.replace(AIDA_TAG, " ").replace(/\s+/g, " ").trim();
  return { question };
}
