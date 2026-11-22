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
 *   "@Rosey done <text>" / "@רוזי בוצע <text>" → mark the matching task done
 *   "@Rosey done" quoting a message     → mark that message's task done
 *
 * A single line is ONE task even if it contains commas: "חלב, ביצים ולחם"
 * cannot be split reliably ("ביצים ולחם" is one item or two?), and a wrong split
 * is worse than a coarse task. Lines are the unit the sender chose.
 */

/** Max characters kept per task title; longer lines are a paragraph, not a task. */
export const MAX_TITLE_CHARS = 200;

/** The words that turn a tag into a completion. Matched as the first word. */
const DONE_WORDS = ["done", "בוצע", "בוצעה", "סיימתי"];

export type RoseyCommand = { kind: "add"; items: string[] } | { kind: "done"; query: string };

export type TagMatcher = {
  /** True when `text` carries any Rosey alias. */
  isTagged(text: string): boolean;
  /** Parse the explicit command, or null when untagged / nothing to do. */
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

  return {
    isTagged: (text) => !!text && tagTest.test(text),
    parse(text) {
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
      const items = body.map(cleanItem).filter((i) => i.length > 0);
      return items.length > 0 ? { kind: "add", items } : null;
    },
  };
}
