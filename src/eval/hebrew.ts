/**
 * hebrew.ts — text normalization for Hebrew evaluators.
 *
 * Matching Hebrew with naive `includes()` is a trap, for three independent
 * reasons, each of which has bitten real eval harnesses:
 *
 *  1. **Invisible characters.** WhatsApp text carries bidi controls (RLM/LRM,
 *     embedding marks). They render as nothing and silently break a regex that
 *     looks correct in the source. This is the classic RTL eval bug.
 *  2. **Niqqud.** Vowel points are combining marks; "מָצָאתִי" and "מצאתי" are the
 *     same word and different strings.
 *  3. **Morphology.** Hebrew attaches prepositions/articles/conjunctions as
 *     PREFIXES: לפגישה · בפגישה · הפגישה · ולפגישה all contain פגישה. A stem
 *     match must tolerate them — and `\b` is ASCII-only, so it never fires on a
 *     Hebrew letter and cannot help.
 *
 * Everything here is pure and synthetic-testable, so it runs in GitHub CI (no
 * corpus, no model). See {@link stemPattern} for the morphology helper.
 */

// ── Normalization ───────────────────────────────────────────────────────────

/** Niqqud + cantillation (U+0591–U+05C7). Combining marks, invisible to `===`. */
const NIQQUD = /[֑-ׇ]/g;

/**
 * Bidi controls. WhatsApp/RTL editors sprinkle these around mixed
 * Hebrew/English/emoji runs; they are zero-width and would otherwise sit
 * *inside* a phrase we're matching ("לא‏מצאתי") and defeat it.
 */
const BIDI = /[‎‏‪-‮⁦-⁩]/g;

/** Zero-width joiners/spaces — same class of problem, different origin (emoji). */
const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * Hebrew final forms. Only the FIVE letters that have them; a final form is the
 * same letter, so ם→מ etc. lets a stem match a word-final occurrence.
 * NOTE: this is destructive and correct only for *matching*, never for display.
 */
const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

/**
 * Canonical form for MATCHING ONLY — never render this to a user.
 *
 * NFC first (compose combining marks so the niqqud strip sees them), then remove
 * what is invisible or decorative, then fold finals and collapse whitespace.
 */
export function normalizeHebrew(text: string): string {
  return text
    .normalize("NFC")
    .replace(BIDI, "")
    .replace(ZERO_WIDTH, "")
    .replace(NIQQUD, "")
    .replace(/[ךםןףץ]/g, (c) => FINALS[c] ?? c)
    .replace(/\s+/g, " ")
    .trim();
}

// ── Morphology-tolerant matching ────────────────────────────────────────────

/**
 * The Hebrew clitic prefixes that can attach to a noun/verb: ו כ ל ב ה מ ש.
 * They stack (ו+כ+ש+ה…), hence `*` rather than `?`.
 */
const CLITICS = "[ובלכהמש]*";

/**
 * Build a regex matching `stem` with any stack of clitic prefixes.
 *
 * `stemPattern("פגישה")` matches פגישה · לפגישה · בפגישה · הפגישה · ולפגישה.
 *
 * Deliberately NOT anchored at a word end: Hebrew also suffixes (possessives,
 * plurals), and over-anchoring produces false negatives — the failure mode that
 * matters here, since a missed match silently understates a metric.
 *
 * Caller must pass an ALREADY-normalized stem (see {@link normalizeHebrew}).
 */
export function stemPattern(stem: string): RegExp {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${CLITICS}${escaped}`, "u");
}

/** True when `text` contains `stem`, tolerating clitics, niqqud and bidi noise. */
export function containsStem(text: string, stem: string): boolean {
  return stemPattern(normalizeHebrew(stem)).test(normalizeHebrew(text));
}

/**
 * True when `text` contains `phrase` (a MULTI-WORD phrase), normalization-aware.
 *
 * Prefer this over {@link containsStem} for anything ambiguous: single Hebrew
 * tokens are famously overloaded (הקפה = "orbit" | "the coffee" | "her
 * perimeter"), so a one-token match invites false positives. A phrase like
 * "לא מצאתי" has no such ambiguity.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  return normalizeHebrew(text).includes(normalizeHebrew(phrase));
}
