/**
 * tags.ts — Rosey's plain-text tag (@Rosey / @רוזי) and the explicit commands
 * it carries.
 *
 * Plain text, not a WhatsApp structured mention: Rosey shares the owner's linked
 * device (D1), so there is no separate account to mention. Same shape as @Aida's
 * trigger, deliberately in its own module (D6) with its own aliases.
 *
 * Grammar (deterministic — no model involved):
 *   "@Rosey <item>"                     → add one task
 *   "@Rosey\n- item\n- item"           → add one task per line (list-item
 *                                          granularity: one message, N tasks)
 *   "@Rosey קניות: <item>" / "@Rosey shopping: <item>"
 *                                       → add a GROCERY item (a list below works too)
 *   "@Rosey קניות\n- item\n- item"      → the grocery word alone on its line: a grocery list
 *   "@Rosey done <text>" / "@רוזי בוצע <text>" → mark the matching task done
 *   "@Rosey done" quoting a message     → mark that message's task done
 *   "@Rosey מה המשימות?" / "@Rosey list" → a LIST REQUEST (see LIST_PHRASES):
 *                                          never an item; the live path may reply
 *
 * Without a grocery prefix, an added item is a task. The prefix must be the
 * grocery word followed by a colon, or alone on the first line: "@Rosey קניות
 * לשבת" ("shopping for Shabbat") is one task, not a grocery item "לשבת".
 *
 * A single line is ONE task even if it contains commas: "חלב, ביצים ולחם"
 * cannot be split reliably ("ביצים ולחם" is one item or two?), and a wrong split
 * is worse than a coarse task. Lines are the unit the sender chose.
 */

import type { RoseyItemKind } from "./kind.js";

/** Max characters kept per task title; longer lines are a paragraph, not a task. */
export const MAX_TITLE_CHARS = 200;

/** The words that turn a tag into a completion. Matched as the first word. */
const DONE_WORDS = ["done", "בוצע", "בוצעה", "סיימתי"];

/** The words that make an add a grocery list. Matched as the first word, with a colon or alone. */
const GROCERY_WORDS = ["קניות", "grocery", "groceries", "shopping"];

/**
 * The whole of a list request, once the tag is taken out (case, direction
 * marks, closing punctuation and spacing aside). A fixed set, never the model:
 * a reply is a send, and only these exact asks may cause one. "@Rosey מה יש
 * לאכול" is not here, so it stays an ordinary item.
 */
export const LIST_PHRASES: readonly string[] = [
  "list",
  "the list",
  "task list",
  "the task list",
  "tasks",
  "the tasks",
  "what's the list",
  "what is the list",
  "what's the task list",
  "what is the task list",
  "what's on the list",
  "what are the tasks",
  "show the list",
  "show list",
  "show tasks",
  "show the tasks",
  "show the task list",
  "רשימה",
  "הרשימה",
  "רשימת משימות",
  "רשימת המשימות",
  "משימות",
  "המשימות",
  "מה המשימות",
  "מה הרשימה",
  "מה ברשימה",
  "מה יש",
  "מה יש ברשימה",
  "מה פתוח",
  "תראי רשימה",
  "תראי הרשימה",
  "תראי משימות",
  "תראי המשימות",
];

/**
 * Words a list request may carry around a phrase without changing it: "את",
 * "בבקשה", "לי", possessives ("המשימות שלנו"), "please", "me". Dropped as
 * whole words before the fixed-phrase lookup. English "our"/"my" read as
 * "the" ("show my list" = "show the list").
 */
const LIST_FILLER = new Set(["את", "בבקשה", "לי", "שלנו", "שלי", "please", "pls", "me"]);
const LIST_POSSESSIVE = new Set(["our", "my"]);

/** A list request's text with the tag already removed, in LIST_PHRASES' form. */
function listKey(rest: string): string {
  return rest
    .replace(/[\u200e\u200f]/g, "")
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/[?？!.,…:;]+/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !LIST_FILLER.has(w))
    .map((w) => (LIST_POSSESSIVE.has(w) ? "the" : w === "whats" ? "what's" : w))
    .filter((w, i, all) => !(w === "the" && all[i - 1] === "the"))
    .join(" ");
}

/**
 * Names the list or its tasks as the thing asked ABOUT: "המשימות", "ברשימה",
 * "מהרשימה", "tasks", "the list". A Hebrew word with any other letter in front
 * does not count, so "לרשימה" / "למשימות" ("to the list") never match.
 */
const NAMES_LIST = /(?<!\p{L})(?:ה|ב|מה)?(?:רשימ|משימ)|\b(?:lists?|tasks?|to-?dos?)\b/iu;
/** Asks what to ADD: such a question is a command, not a question about the list. */
const ADDS_TO_LIST =
  /(?<!\p{L})(?:להוסיף|תוסיפי|הוסיפי)(?!\p{L})|\badd\b|\bto (?:the |our |my )?(?:list|tasks)\b/iu;
/** Opens like a question: "מה …", "איזה …", "which …", "anything …". */
const QUESTION_START =
  /^(?:מה|מהן|מהם|איזה|איזו|אילו|כמה|מי|האם|what|what's|whats|which|anything)(?![\p{L}\p{N}'])/iu;

/**
 * A one-line question about the list itself ("@Rosey מה עם המשימות של
 * השבוע?") that missed LIST_PHRASES. It is not a list request (that stays a
 * fixed pattern), but it is never an item either: storing a question about the
 * list as a task is the worse mistake. Everything else falls through to the
 * command parser: "לקנות רשימה של מתנות" is no question, and "מה לקנות
 * לרשימה" asks what to add, so both become items.
 */
function isListQuestion(lines: readonly string[]): boolean {
  if (lines.length !== 1) return false;
  const line = lines[0]!.replace(/[\u200e\u200f]/g, "").replace(/^[\s,:]+/, "");
  return (
    NAMES_LIST.test(line) &&
    !ADDS_TO_LIST.test(line) &&
    (/[?？]\s*$/u.test(line) || QUESTION_START.test(line))
  );
}

const LIST_KEYS = new Set(LIST_PHRASES);

export type RoseyCommand =
  | { kind: "add"; items: string[]; itemKind: RoseyItemKind }
  | { kind: "done"; query: string };

export type TagMatcher = {
  /** True when `text` carries any Rosey alias. */
  isTagged(text: string): boolean;
  /** True when `text` is a tagged list request and nothing else (LIST_PHRASES). */
  isListRequest(text: string): boolean;
  /** Parse the explicit command, or null when untagged / nothing to do / a list request. */
  parse(text: string): RoseyCommand | null;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse ROSEY_TAGS ("@Rosey,@רוזי") into normalized aliases. A missing leading
 * "@" is added: the tag must stay a token nobody types by accident.
 */
export function parseTagAliases(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const t = part.trim().replace(/^@+/, "");
    if (t) out.add(`@${t}`);
  }
  return [...out];
}

// Leading list markers a person types before an item: "-", "*", "•", "1.", "2)",
// a checkbox emoji. Stripped so "- חלב" and "חלב" are the same task.
const BULLET = /^\s*(?:[-*•·▪◦]|\d{1,2}[.)]|(?:☐|☑|✅|✔️?|⬜)+)\s*/u;

function cleanItem(line: string): string {
  return line.replace(BULLET, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

export function makeTagMatcher(aliases: readonly string[]): TagMatcher {
  if (aliases.length === 0) throw new Error("Rosey needs at least one tag alias");
  // Unicode boundary after the tag: `\b` is ASCII-only and never fires after a
  // Hebrew letter. "@Roseyy"/"@רוזיה" don't match; "@Rosey," and end-of-text do.
  const source = `(?:${aliases.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`;
  const tagTest = new RegExp(source, "iu");
  const tagStrip = new RegExp(source, "giu");
  const doneWord = new RegExp(
    `^(?:${DONE_WORDS.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])[\\s:,.-]*`,
    "iu",
  );
  const groceryWord = `(?:${GROCERY_WORDS.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`;
  // "קניות: חלב" (a colon, then items on this line or below) or "קניות" alone on its line.
  // Hebrew WhatsApp text carries invisible direction marks (LRM/RLM), and a
  // phone keyboard may type a full-width colon: both count as the plain ones.
  const gap = "[\\s\\u200e\\u200f]*";
  const groceryHead = new RegExp(`^${gap}${groceryWord}${gap}(?:[:：]${gap}|$)`, "iu");

  const isListRequest = (text: string) =>
    !!text && tagTest.test(text) && LIST_KEYS.has(listKey(text.replace(tagStrip, " ")));

  return {
    isTagged: (text) => !!text && tagTest.test(text),
    isListRequest,
    parse(text) {
      // A list request asks; it adds nothing. Null here keeps a replay of it
      // (the catch-up parses stored messages) from storing it as an item.
      if (isListRequest(text)) return null;
      if (!text || !tagTest.test(text)) return null;
      // Remove the tag but keep the line structure — lines are the item unit.
      const body = text
        .replace(tagStrip, " ")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const first = body[0] ?? "";
      if (doneWord.test(first)) {
        const rest = [first.replace(doneWord, ""), ...body.slice(1)].join(" ");
        return { kind: "done", query: rest.replace(/\s+/g, " ").trim() };
      }
      if (isListQuestion(body)) return null;
      const grocery = groceryHead.test(first);
      const lines = grocery ? [first.replace(groceryHead, ""), ...body.slice(1)] : body;
      const items = lines.map(cleanItem).filter((i) => i.length > 0);
      return items.length > 0
        ? { kind: "add", items, itemKind: grocery ? "grocery" : "task" }
        : null;
    },
  };
}
