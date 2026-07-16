/**
 * denial.ts — detect when @Aida refuses to answer.
 *
 * This is THE load-bearing evaluator: the headline metric is
 *
 *     false_denial = refused(answer) ∧ gold_message ∈ context
 *
 * which decomposes the bug (denial ∧ gold ∉ top-k → retrieval; denial ∧ gold ∈
 * top-k → generation). Both terms are deterministic — no LLM judge. That is not
 * a privacy compromise: a gemma-class Hebrew judge is independently unreliable
 * (multilingual judges average Fleiss' κ≈0.3; models <14B cannot use judge-prompt
 * guidance; judging gemma with gemma is self-preference bias).
 *
 * ── Why regex works here, unusually ──────────────────────────────────────────
 * The refusal strings are OURS (ask/prompt.ts), not the model's invention. In
 * practice gemma4 emits OFF_TOPIC/NOT_INDEXED close to verbatim but PARAPHRASES
 * NOT_IN_CHAT freely ("לא מצאתי ששאלו אותי משהו באופן אישי"). Every observed
 * paraphrase keeps the stem "לא מצאתי", so exact-match ∪ phrase-match covers it.
 *
 * ── This detector has its own error rate ─────────────────────────────────────
 * An unvalidated regex is just an unvalidated judge with worse recall. It is
 * measured against hand-labelled real answers by `aida-eval validate-detector`
 * (see denial-validate.ts); treat its precision/recall as a reported number, not
 * an assumption.
 */

import { NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC } from "../ask/prompt.js";
import { containsPhrase, normalizeHebrew } from "./hebrew.js";

/**
 * Which refusal. They are NOT interchangeable:
 *  - `not_in_chat`  — "it wasn't said". A factual claim about the conversation.
 *  - `off_topic`    — "that's not about this group". A scope refusal.
 *  - `not_indexed`  — "I can't see the messages yet". An operational state.
 * A false `not_in_chat` is the bug; a false `off_topic` on an on-topic question
 * is a different bug with the same smell.
 */
export type RefusalKind = "not_in_chat" | "off_topic" | "not_indexed";

/**
 * `full` — the reply is *only* a refusal.
 * `partial` — refusal plus substantive content ("לא מצאתי הרבה, אבל רועי אמר…").
 * Binary would hide `partial`, which is the same failure in a politer register
 * (XSTest grades full/partial/compliance for exactly this reason).
 */
export type RefusalDegree = "full" | "partial";

export type Refusal = { kind: RefusalKind; degree: RefusalDegree };

/**
 * The persona prefix, stripped before judging "is there content besides the
 * refusal".
 *
 * Built from the NORMALIZED spelling on purpose: normalizeHebrew folds final
 * forms, so "תכף" becomes "תכפ" and a pattern written in display spelling would
 * silently never match. Deriving it keeps the two in lockstep instead of
 * hard-coding a form that looks wrong to a Hebrew reader.
 */
const PERSONA = new RegExp(`^${normalizeHebrew("תכף תכף")}\\s*\\.*\\s*`, "u");

/**
 * Paraphrase markers per kind, most-specific first. Multi-word phrases only:
 * single Hebrew tokens are too ambiguous to anchor on (הקפה = orbit | the coffee
 * | her perimeter), and a false positive here silently inflates the headline
 * metric.
 */
const MARKERS: Record<RefusalKind, string[]> = {
  not_indexed: [NOT_INDEXED, "אין לי גישה להודעות", "עדיין אין לי גישה"],
  off_topic: [OFF_TOPIC, "אני עונה רק על מה שנאמר", "עונה רק על מה שנאמר בשיחה"],
  not_in_chat: [
    NOT_IN_CHAT,
    "לא מצאתי", // the stem every observed paraphrase keeps
    "לא נמצא", // covers נמצא/נמצאה/נמצאו — word order varies ("לא נמצאה הודעה בשיחה")
    "לא ראיתי",
    "לא הצלחתי למצוא",
    "לא צוין",
  ],
};

/**
 * Adversative/exceptive connectors — the signature of a PARTIAL refusal, which is
 * semantically "no, BUT …": לא מצאתי X, **רק ש**רועי שאל Y.
 *
 * Chosen over a residual-length heuristic, which fails twice: gemma joins clauses
 * with commas (so sentence-splitting sees one sentence), and a merely *verbose*
 * full denial ("לא מצאתי ששאלו אותי שאלה אישית בקבוצה") would score partial
 * despite adding no information.
 *
 * Must be tested against the residual AFTER the marker is removed — OFF_TOPIC's
 * own canonical text contains רק ("אני עונה רק על מה שנאמר…") and would otherwise
 * grade itself partial.
 */
const ADVERSATIVE = /(אבל|אך|אלא|רק|למעט|מלבד|לעומת)/u;

/**
 * Classify a refusal, or null when the answer does not refuse.
 *
 * Order matters, and is precedence, not convenience:
 *  1. `not_indexed` first — an honest "I can't see the messages yet" must never
 *     be counted as a false denial; that would invert the signal.
 *  2. `not_in_chat` before `off_topic` — she mixes them ("לא מצאתי התייחסות…
 *     אני עונה רק על מה שנאמר"), and in a mixed reply the factual claim about
 *     the conversation is the primary refusal and the one the headline metric
 *     tracks. Labelling it `off_topic` would let a false denial escape.
 *     Safe because neither NOT_INDEXED nor OFF_TOPIC contains a "לא מצאתי" stem.
 */
export function detectRefusal(answer: string): Refusal | null {
  const body = normalizeHebrew(answer).replace(PERSONA, "");
  for (const kind of ["not_indexed", "not_in_chat", "off_topic"] as const) {
    const hit = MARKERS[kind].find((m) => containsPhrase(body, m));
    if (hit) return { kind, degree: gradeDegree(body, hit) };
  }
  return null;
}

/** Shortest surviving other-sentence that still counts as substantive content. */
const SUBSTANTIVE_MIN = 15;

/**
 * `full` — the reply is only a refusal. `partial` — it refuses AND offers
 * something.
 *
 * Two signals, because gemma expresses "no, but…" two different ways and each
 * signal alone misgrades real replies:
 *
 *  - **Adversative inside the refusal's own sentence** — "לא מצאתי X, רק היו
 *    הודעות על Y". Length alone can't see this (it's one clause).
 *  - **A separate sentence with real content** — "אני אידה, חברה בקבוצה הזו.
 *    …לא מצאתי…". No connector appears, so the adversative alone misses it.
 *
 * Length over the WHOLE residual is deliberately not used: it misgrades a merely
 * verbose full denial ("לא מצאתי בשיחה מישהו בשם רועי או אזכור של מה שהוא רוצה")
 * as partial, when it adds no information.
 */
function gradeDegree(body: string, hit: string): RefusalDegree {
  // Drop the marker's own trailing punctuation: the canonical constants end in
  // "." but sentences are split ON ".", so an unstripped marker never matches a
  // sentence and every reply would fall back to "all other content" → partial.
  const marker = normalizeHebrew(hit).replace(/[.!?]+$/u, "");
  const sentences = body.split(/[.!?\n]+/u).filter((s) => s.trim().length > 0);
  const idx = sentences.findIndex((s) => s.includes(marker));
  if (idx < 0) return ADVERSATIVE.test(body.replace(marker, " ")) ? "partial" : "full";
  const others = sentences
    .filter((_, i) => i !== idx)
    .join(" ")
    .trim();
  if (others.length >= SUBSTANTIVE_MIN) return "partial";
  return ADVERSATIVE.test((sentences[idx] ?? "").replace(marker, " ")) ? "partial" : "full";
}

/** Convenience: did she refuse at all (either degree)? */
export function refused(answer: string): boolean {
  return detectRefusal(answer) !== null;
}
