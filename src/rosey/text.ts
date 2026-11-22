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
    .replace(/\u05be/g, " ") // maqaf: a Hebrew hyphen, so a word break like "-"
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
 *
 * `accept` names the shape the caller wants. A complete value of another shape
 * (a trailing `{"confidence": "high"}` after the answer) is skipped WHOLE —
 * nothing inside it is considered — and the scan goes on to the left.
 */
export function lastJsonValue(text: string, accept: (v: unknown) => boolean = () => true): unknown {
  let end = text.length;
  while (end > 0) {
    const close = Math.max(text.lastIndexOf("}", end - 1), text.lastIndexOf("]", end - 1));
    if (close < 0) return null;
    const start = matchingOpen(text, close);
    let parsed: { v: unknown } | null = null;
    if (start >= 0) {
      try {
        parsed = { v: JSON.parse(text.slice(start, close + 1)) };
      } catch {
        // Balanced but not JSON (prose with brackets) — keep scanning left.
      }
    }
    if (parsed && accept(parsed.v)) return parsed.v;
    end = parsed ? start : close;
  }
  return null;
}

/**
 * The objects of a reply's LAST `"items": [...]` array, parsed one by one —
 * for a reply that is not valid JSON as a whole.
 *
 * Measured on the real chat: the local model sometimes garbles one cited id
 * (`"m": 10625cut57`), and that one object made the whole reply unparseable,
 * so every item of the batch was lost. Here each top-level object of the array
 * stands alone: a broken one is counted in `malformed`, never repaired (gluing
 * digits back together would be a guess), and the rest are kept.
 *
 * An array that never closes is a TRUNCATED reply and yields null: salvaging
 * its head would read as a complete answer, and the cursor would move past the
 * items the model never got to write.
 */
export function salvageItemObjects(text: string): { objects: unknown[]; malformed: number } | null {
  const key = /"items"\s*:\s*\[/g;
  let open = -1;
  for (let m = key.exec(text); m; m = key.exec(text)) open = m.index + m[0].length - 1;
  if (open < 0) return null;
  const close = closesAt(text, open);
  if (close < 0) return null;
  const out = { objects: [] as unknown[], malformed: 0 };
  for (let i = open + 1; i < close; i++) {
    if (text[i] !== "{") continue;
    const end = closesAt(text, i);
    if (end < 0 || end > close) return null;
    try {
      out.objects.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      out.malformed++;
    }
    i = end;
  }
  return out;
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
