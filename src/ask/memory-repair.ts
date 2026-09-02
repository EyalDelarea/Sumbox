/**
 * memory-repair.ts — reading a belief back against the messages it came from.
 *
 * The counterweight `memory-extract.ts` never had. Its `validateCandidate` is a
 * check over the SHAPE of what the model returned — does this id exist, does this
 * name resolve, are there two authors — and every one of those can pass while the
 * sentence says something the cited message does not. Measured on group 70, 5 of
 * 11 stored beliefs were wrong that way, and containment refused none of them
 * because there was nothing malformed to refuse.
 *
 * THE PASS IS BLIND, AND THAT IS THE WHOLE MECHANISM. It sees one belief and the
 * text of the messages that belief cites. Not the group, not the window, not what
 * else is believed about that person. Extraction is open generation over 300
 * messages with a broad brief; this is a close reading of one sentence against
 * two or three. They are different tasks, and the difference is the reason to
 * expect a different answer from the same model — a prior about the person is
 * exactly what turns "I'm in Rishon, covered in dust" into a residence.
 *
 * IT REPAIRS RATHER THAN REJECTS. A gate that refused the 42% would leave about
 * six beliefs standing from thirteen weeks of chat. A rewrite keeps the belief
 * and removes what the evidence does not carry — "lives in Jaffa" becomes "used
 * to live in Jaffa", and only a belief with nothing left is dropped.
 *
 * WHAT THIS MODULE DOES NOT DO: decide whether a belief is interesting, compare
 * it against anything else on file, or touch the database. It is the pure half —
 * a prompt, a parse and a shape check — so that the run can be repeated and read.
 */

// ── Vocabulary ────────────────────────────────────────────────────────────

/** What the pass decided about one belief. */
export type RepairAction = "keep" | "rewrite" | "drop";

/**
 * One decision, after shape-checking.
 *
 * `content` is what should stand — the original for `keep`, the correction for
 * `rewrite`, and empty for `drop`. `reason` is never optional: a drop with no
 * reason is a silent deletion, which is the failure this pass is most likely to
 * introduce and the hardest to notice afterwards.
 */
export type RepairVerdict = {
  action: RepairAction;
  content: string;
  reason: string;
};

/**
 * Why a reply was refused. Counted separately for the same reason extraction
 * counts its own: a model that stopped answering in JSON is a different event
 * from one that answered with an action nobody asked for.
 */
export type RepairRejection =
  | "unparseable"
  | "not-an-object"
  | "bad-action"
  | "empty-content"
  | "too-long"
  | "no-reason";

/** One cited message, as the pass is allowed to see it. */
export type CitedMessage = {
  messageId: number;
  /** The name shown before the colon, the same rendering extraction used. */
  author: string;
  text: string;
};

/** The belief under review. Deliberately not the stored row — see below. */
export type BeliefUnderReview = {
  memoryType: string;
  content: string;
};

/**
 * The longest repair that may stand.
 *
 * The same bound `validateCandidate` applies, and it has to be the same one: a
 * rewrite that cleared this pass and then failed storage would be a correction
 * the operator watched happen and never got.
 */
export const MAX_REPAIR_CONTENT = 500;

// ── Step one: is it supported at all? ─────────────────────────────────────

/** Whether every part of a belief is carried by its citations, and why. */
export type JudgeVerdict = { supported: boolean; reason: string };

export type JudgeRejection = "not-an-object" | "bad-supported" | "no-reason";

/**
 * Ask ONLY whether the belief is supported. No rewriting is on the table.
 *
 * SPLIT OUT OF THE REPAIR CALL AFTER MEASURING IT. Asked to judge and to correct
 * in one breath, the model kept NOTHING: 0 keeps across 11 beliefs, three
 * identical runs, and again 0 after a prose rule was added telling it that
 * keeping is the normal answer. Anything re-read closely looks improvable, and
 * "leave it alone" was competing with the far more interesting option of editing
 * it. Making it the answer to a yes/no question removes the competition — the
 * same lesson as every other fix on this stack: move the rule into the structure
 * rather than write it more firmly.
 *
 * The four tests are the same ones the rewrite applies, and they have to be: a
 * belief judged unsupported for a reason the rewrite does not recognise would
 * come back rewritten for a different one.
 */
export function buildJudgePrompt(belief: BeliefUnderReview, cited: CitedMessage[]): string {
  return [
    "Below is a belief and the messages it was drawn from. Say whether those",
    "messages actually support it. Do not rewrite anything.",
    "",
    "IT IS SUPPORTED ONLY IF ALL OF THESE HOLD:",
    "1. Every place, name, number and time in the belief appears in a message below.",
    '2. The tense matches. "I used to live there" does NOT support "lives there".',
    '   "I am in X" does NOT support "lives in X". "planning" does NOT support "doing".',
    "3. Direction and detail match. A message saying the SIDES of the room does not",
    "   support a belief about the ceiling.",
    '4. A habit ("always", "usually", "habitually") needs more than one occasion.',
    "",
    "If all four hold, it is supported. Most beliefs written carefully ARE supported —",
    "say so plainly rather than looking for something to improve.",
    "",
    "Reply with ONE JSON object and nothing else:",
    '  {"supported":true,"reason":"..."}',
    '  {"supported":false,"reason":"<which rule it breaks, in one short English sentence>"}',
    "",
    `THE BELIEF (kind: ${belief.memoryType}):`,
    belief.content,
    "",
    "THE MESSAGES IT CITES:",
    renderCited(cited),
  ].join("\n");
}

/** Shape-check the judge's reply. `supported` must be a real boolean, never a guess. */
export function validateJudge(raw: unknown): {
  ok: JudgeVerdict | null;
  reason?: JudgeRejection;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: null, reason: "not-an-object" };
  }
  const r = raw as { supported?: unknown; reason?: unknown };
  // A string "false" is not a false, and coercing one would read a refusal as an
  // approval — the direction that silently keeps a wrong belief.
  if (typeof r.supported !== "boolean") return { ok: null, reason: "bad-supported" };
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  if (reason.length === 0) return { ok: null, reason: "no-reason" };
  return { ok: { supported: r.supported, reason } };
}

/**
 * The longest a cited message may show to the model.
 *
 * ALSO THE BOUND A REPORTED RECORD MUST NOT EXCEED. `citedMessagesFor` in
 * `memory-repair-run.ts` used to thread the FULL message text into
 * `RepairRecord` while this constant only bounded what went into the prompt —
 * so the printed/`--report`ed record showed more of the message than the
 * model ever read. One constant, applied on both sides, is what keeps that
 * from drifting apart again.
 */
export const MAX_CITED_MESSAGE_CHARS = 500;

/** Whitespace-collapse and cut to {@link MAX_CITED_MESSAGE_CHARS} — the exact transform the model sees. */
export function truncateCitedText(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, MAX_CITED_MESSAGE_CHARS);
}

/** One cited message per line, id and author included, whitespace collapsed. */
function renderCited(cited: CitedMessage[]): string {
  return cited.map((m) => `[${m.messageId}] ${m.author}: ${truncateCitedText(m.text)}`).join("\n");
}

// ── The prompt ────────────────────────────────────────────────────────────

/**
 * Ask whether these messages actually say this belief.
 *
 * THE TEST COMES FIRST, BEFORE THE BELIEF OR THE MESSAGES. Position has decided
 * whether a rule binds every time it has been measured on this stack — the same
 * guard failed at line 8 of a prompt and worked at line 2 — so the four rules sit
 * above everything they apply to.
 *
 * EVERY RULE IS A FAILURE THAT HAPPENED, not a precaution:
 *
 * - `שכחתי שגרתי שם` ("I forgot I used to live there") became "lives in Jaffa",
 *   and `אני בראשון עם אבק` ("I'm in Rishon, covered in dust") became "lives in
 *   Rishon" — so the tense rule is stated as those two shapes, not as "check the
 *   tense".
 * - A birthday message and an unrelated travel story became one event "in the
 *   Arava", a place written in neither. Hence: a place or a number not written
 *   below is invented.
 * - "I took the ceiling panels and put them on the SIDES of the room" became
 *   "uses panels in the ceiling" — the belief asserting the opposite of its
 *   source. That is its own rule because it is not a tense error and would not be
 *   caught by one.
 * - One message about eating toast at seven became "they habitually tease each
 *   other". Hence the rule against a habit drawn from a single occasion.
 *
 * Rules 5-7 come from the FIRST run of this pass, over the eleven beliefs on
 * group 70 — three identical runs, 9 rewrites, 2 drops and NOT ONE keep. Rules
 * 1-4 are all subtractive, so the cheapest way to satisfy them is to quote the
 * source, and that is what it did:
 *
 * - Two beliefs that were already correct were "improved" into worse ones. Hence
 *   rule 5: keeping has to be named as the normal answer, or every belief reads
 *   as improvable.
 * - "lives in Rishon" was rewritten to `אני בראשון עם אבק` — the cited message,
 *   verbatim, in the first person. Hence rule 6: what comes back must still be a
 *   belief about somebody, not the sentence it was read from.
 * - "he lives in Jaffa" became "he lives there". Rule 1 was RIGHT — `יפו` is in
 *   no cited message, because the extractor took the place from a message it
 *   never cited — but with nothing left to say, a vaguer belief is worse than
 *   none. Hence rule 7.
 *
 * THE MEMORY TYPE IS SHOWN AND NOTHING ELSE IS. A relational belief is supposed
 * to be about two people and an episodic one about none, so a reader that did not
 * know which kind it held would call a correct belief unsupported. Everything
 * beyond that — the group, the subject's other beliefs, the rest of the window —
 * is withheld on purpose; it is the prior that produced the errors above.
 */
export function buildRepairPrompt(belief: BeliefUnderReview, cited: CitedMessage[]): string {
  return [
    "A belief was extracted from the messages below. Decide whether those messages",
    "actually say it, and correct it if they do not.",
    "",
    "APPLY THESE LITERALLY:",
    "1. Every place, name, number and time in the belief must appear in a message",
    "   below. Anything else was invented — remove it.",
    '2. Tense must match. "I used to live there" is NOT "lives there".',
    '   "I am in X" is where someone is standing, NOT where they live.',
    '   "planning" is NOT "doing", and "will" is NOT "did".',
    "3. Direction and detail must match. If a message says the SIDES of the room,",
    "   the belief may not say the ceiling.",
    '4. One occasion is not a habit. Never write "always", "usually" or',
    '   "habitually" on the strength of a single message.',
    "5. If the belief passes rules 1-4, keep it UNCHANGED. Keeping is the normal",
    "   answer — do not improve a belief that is already right.",
    "6. The result must stay a belief ABOUT someone, written in the third person.",
    '   Never copy a message as the belief. Never write "I".',
    "7. If what survives is not a usable belief on its own, drop it — never write",
    '   a vaguer one. "he lives there" with no place is not a belief.',
    "",
    "Reply with ONE JSON object and nothing else:",
    '  {"action":"keep","content":"<the belief, unchanged>","reason":"..."}',
    '  {"action":"rewrite","content":"<the corrected belief>","reason":"..."}',
    '  {"action":"drop","content":"","reason":"..."}',
    "",
    "Rewrite when part of the belief survives. Drop only when nothing does.",
    "Write content in the SAME LANGUAGE as the messages — never translate it.",
    "Give the reason in English, in one short sentence.",
    "",
    `THE BELIEF (kind: ${belief.memoryType}):`,
    belief.content,
    "",
    "THE MESSAGES IT CITES:",
    renderCited(cited),
  ].join("\n");
}

// ── Parsing and shape ─────────────────────────────────────────────────────

/**
 * Pull ONE JSON object out of a reply — the LAST one that actually parses.
 *
 * MEASURED, NOT HYPOTHETICAL: over three calibration runs the local model
 * emitted a fenced verdict, then "Wait, ..." prose re-reading itself, then a
 * SECOND fenced object — its corrected final answer. The naive first-`{` to
 * last-`}` slice used to span both objects and hand `JSON.parse` a string
 * that could never be valid, refusing 2 of 11 beliefs deterministically for a
 * reason that had nothing to do with what either object said.
 *
 * So this scans for every BALANCED top-level `{...}` (brace-depth tracked,
 * braces inside a JSON string ignored so a quoted `{` in a belief's own text
 * can't fool the scan) and tries each from last to first, returning the first
 * that parses. The last one is the model's self-correction; an earlier one is
 * only used when every later object is itself unparseable. Null only when
 * none of them parse — the same tolerant contract as before, just no longer
 * confused by a reply that contains more than one object.
 *
 * A DELIBERATE OPENING LEFT UNCLOSED: if a model ever echoed the prompt's own
 * example objects (`{"action":"drop",...}` and friends) after its real
 * answer, last-wins would pick the echo. That has not been observed and
 * `validateRepair` still shape-checks whatever comes out, but it is a known
 * trade of "prefers the model's correction" for "assumes the last object is
 * the real one" — not something this function can tell apart on its own.
 */
export function parseRepair(text: string): unknown {
  const objects = balancedObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(objects[i] as string);
    } catch {
      // Try the next-earlier balanced object.
    }
  }
  return null;
}

/** Every substring of `text` that is a complete, brace-balanced `{...}` span. */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      // Only tracked once inside an object: a stray quote in surrounding prose
      // (a model narrating `it says "lives in Jaffa" but...` before its JSON)
      // must not swallow the object that follows as unterminated string
      // content — a JSON string only exists inside an object to begin with.
      if (depth > 0) inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

const ACTIONS: readonly RepairAction[] = ["keep", "rewrite", "drop"];

/**
 * Check one reply, and normalise the two ways it can agree with itself.
 *
 * A REWRITE IDENTICAL TO THE ORIGINAL IS A KEEP. Storing it would mint a
 * supersede row that changes nothing, and the chain of supersessions is the
 * record of what actually changed — padding it with no-ops makes the one real
 * correction harder to find, not easier.
 *
 * A KEEP CARRIES THE ORIGINAL, whatever the model echoed back. The model is
 * being asked a question about a sentence, not asked to retype it, and a keep
 * whose content drifted by a word is a rewrite that did not declare itself.
 *
 * The original is a parameter for both of those, which is why this takes it
 * rather than checking the reply alone.
 */
export function validateRepair(
  raw: unknown,
  original: string,
): { ok: RepairVerdict | null; reason?: RepairRejection } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: null, reason: "not-an-object" };
  }
  const r = raw as { action?: unknown; content?: unknown; reason?: unknown };

  const action = typeof r.action === "string" ? r.action.trim().toLowerCase() : "";
  if (!(ACTIONS as readonly string[]).includes(action)) return { ok: null, reason: "bad-action" };

  // Required on every action, drop included — see {@link RepairVerdict}.
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  if (reason.length === 0) return { ok: null, reason: "no-reason" };

  if (action === "drop") return { ok: { action: "drop", content: "", reason } };

  if (action === "keep") return { ok: { action: "keep", content: original.trim(), reason } };

  const content = typeof r.content === "string" ? r.content.trim() : "";
  if (content.length === 0) return { ok: null, reason: "empty-content" };
  if (content.length > MAX_REPAIR_CONTENT) return { ok: null, reason: "too-long" };
  if (content === original.trim()) return { ok: { action: "keep", content, reason } };
  return { ok: { action: "rewrite", content, reason } };
}
