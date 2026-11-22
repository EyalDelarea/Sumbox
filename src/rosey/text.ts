/**
 * text.ts — small pure helpers shared by Rosey's capture paths.
 */

/**
 * The comparison key for a task title: Unicode-normalized, lowercased, niqqud
 * and punctuation/emoji removed, whitespace collapsed. Two titles with the same
 * key are the same task without asking a model.
 */
export function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "") // Hebrew cantillation + niqqud
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The LAST balanced JSON object or array in a model reply, parsed; null if none.
 *
 * Not the first-brace-to-last-brace slice: the local model sometimes answers,
 * then revises itself in prose with a second JSON block, and that slice spans
 * both and fails to parse. Scanning from the end and taking the last complete
 * value picks the revision, which is the answer the model settled on.
 * String contents are respected, so a "}" inside a title does not unbalance it.
 */
export function lastJsonValue(text: string): unknown {
  let end = text.length;
  while (end > 0) {
    const close = Math.max(text.lastIndexOf("}", end - 1), text.lastIndexOf("]", end - 1));
    if (close < 0) return null;
    const start = matchingOpen(text, close);
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start, close + 1));
      } catch {
        // Balanced but not JSON (prose with brackets) — keep scanning left.
      }
    }
    end = close;
  }
  return null;
}

/** Index of the bracket opening the value that closes at `close`, or -1. */
function matchingOpen(text: string, close: number): number {
  // Walk forward from each candidate opener and see whether it closes exactly at
  // `close`. Forward scanning is what makes string escapes tractable.
  const want = text[close] === "}" ? "{" : "[";
  for (let i = close - 1; i >= 0; i--) {
    if (text[i] !== want) continue;
    if (closesAt(text, i) === close) return i;
  }
  return -1;
}

function closesAt(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const open = stack.pop();
      if ((c === "}" && open !== "{") || (c === "]" && open !== "[")) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
