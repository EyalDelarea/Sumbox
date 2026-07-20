/**
 * groundedness.ts — deterministic numeral-level grounding check.
 *
 * Why numerals: the fabrications that survived every prompt fix (PR #53's
 * absent-03 invented a sports score twice at temp 0) assert CONCRETE numbers.
 * A number the model was never shown is checkable with zero model calls and
 * zero false morphology — unlike Hebrew content words, where clitic prefixes
 * make token presence unmeasurable without a stemmer.
 *
 * Why ≥2 digits: single digits are routinely DERIVED legitimately (counting
 * messages, "3 אנשים אמרו"), so flagging them would trade fabrication for
 * false alarms. A multi-digit run (a score, a time, a price, a year) that
 * appears nowhere in the prompt is near-certainly invented.
 */

export function extractNumerals(text: string): Set<string> {
  return new Set((text.match(/\d+/g) ?? []).filter((run) => run.length >= 2));
}

/** Numerals asserted by `answer` that appear nowhere in `context`. */
export function ungroundedNumerals(answer: string, context: string): string[] {
  const shown = extractNumerals(context);
  return [...extractNumerals(answer)].filter((run) => !shown.has(run)).sort();
}
