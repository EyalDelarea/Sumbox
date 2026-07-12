import type { StructuredSummary, SummaryBullet } from "./summarizer.js";

// ── Heading → bucket map ────────────────────────────────
// Matches the Hebrew ## headings the prompt emits. Unknown headings (e.g.
// "לפי משתתף") are intentionally ignored. actionItems has no heading of its own
// in S3 — the field is reserved for a later slice and stays empty here.
const HEADINGS: Record<string, "tldr" | "topics" | "decisions" | "openQuestions"> = {
  תקציר: "tldr",
  "נושאים עיקריים": "topics",
  "החלטות ומשימות": "decisions",
  "שאלות פתוחות": "openQuestions",
};

const HEADING_RE = /^\s*##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;

// A trailing source citation appended to a bullet. The prompt asks for a bare
// `^N`, but the local model is inconsistent in practice and emits any of:
//   ^6   ^[#6]   ^[#3, #4]   ^4, ^8, ^14   [39, 42]
// optionally followed by sentence punctuation. We accept every shape, strip the
// whole region from the display text, and resolve the FIRST cited index. The
// leading caret-or-bracket is REQUIRED so a bare trailing number stays content
// (a price, a year, "לשעה 14") rather than being mistaken for a marker.
const MARKER_RE =
  /\s*(?:\^\s*\[?\s*#?\s*\d+(?:\s*,?\s*\^?\s*#?\s*\d+)*\s*\]?|\[\s*#?\s*\d+(?:\s*,\s*#?\s*\d+)*\s*\])\s*[.;,]?\s*$/;

// Every marker token ANYWHERE in a value (not just trailing): caret form
// (^6, ^[#6], ^4, ^8) and bracket form ([#6], [#3, #4], [1, 3]) — plus the
// malformed `[#…]` tokens the local model hallucinates (e.g. `[#estimated: true]`).
// The `[#…]` arm matches any bracket that opens with `#`; the digit arm only matches
// brackets of digits/commas so real content like "[3 אנשים]" is left alone.
const MARKER_GLOBAL_RE =
  /\s*(?:\^\s*\[?\s*#?\s*\d+(?:\s*,\s*\^?\s*#?\s*\d+)*\s*\]?|\[\s*#[^\]]*\]|\[\s*#?\s*\d[\d\s,#]*\])/g;

/**
 * A caret with NO index after it — a citation the model failed to complete.
 *
 * The prompt asks for `^N` and says to omit the marker entirely when no single
 * line applies; gemma4:26b routinely does neither and emits a bare `^`. Every
 * regex above requires `\d+` after the caret, so these survived into the rendered
 * Hebrew — seen live as "...וצורך בחומרים ^." and even inside ## תקציר, which the
 * prompt forbids markers in at all.
 *
 * Only strips a caret NOT followed by an index (the lookahead), so real `^N`
 * citations are still parsed by MARKER_GLOBAL_RE and their source ids captured.
 */
const BARE_CARET_RE = /\s*\^(?!\s*\[?\s*#?\s*\d)/g;

/**
 * Parse a Hebrew markdown summary blob into a fielded {@link StructuredSummary}.
 * Pure + total: a model that ignores the format yields `overview = raw` with
 * empty arrays rather than an error, and an out-of-range `^N` marker is dropped
 * (bullet text kept, `sourceMessageId` left undefined).
 *
 * @param raw verbatim model markdown
 * @param indexMap line index (`[#N]`) → messages.id, from the prompt selection
 */
export function parseStructuredSummary(
  raw: string,
  indexMap: Map<number, number>,
): StructuredSummary {
  const result: StructuredSummary = {
    version: 2,
    // Full markdown, with citation markers removed. `overview` is what the CLI,
    // the WhatsApp reply, the legacy history card and "העתק סיכום" all render, so
    // keeping it byte-verbatim meant every raw `^`, `^7` and `^[#75]` the model
    // emitted was shown to the reader as junk. The source ids they encode are
    // still captured on each bullet's sourceMessageId, so nothing is lost.
    overview: stripMarkersForDisplay(raw),
    tldr: "",
    topics: [],
    decisions: [],
    openQuestions: [],
    actionItems: [],
  };

  const tldrLines: string[] = [];
  let current: "tldr" | "topics" | "decisions" | "openQuestions" | null = null;
  let sawHeading = false;

  for (const line of raw.split("\n")) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      sawHeading = true;
      current = HEADINGS[heading[1]!.trim()] ?? null;
      continue;
    }
    if (current === null) continue; // text before/under an unknown heading

    if (current === "tldr") {
      // stripAllMarkers, not stripMarker: the latter only removes a marker at the
      // END of the line, so a caret mid-sentence ("...זוויות ^. המטרה...") survived.
      // The prompt forbids markers in ## תקציר outright, so any here are noise.
      const text = stripAllMarkers(line.trim()).text;
      if (text) tldrLines.push(text);
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (!bullet) continue; // non-bullet noise inside a list section
    const body = bullet[1]!.trim();
    if (!body) continue;
    result[current].push(toBullet(body, indexMap));
  }

  // tldr = the ## תקציר body; when the model ignored the format, fall back to raw.
  result.tldr = sawHeading ? tldrLines.join(" ") : raw.trim();
  return result;
}

/** Build a bullet, resolving a trailing source marker against the index map. */
function toBullet(body: string, indexMap: Map<number, number>): SummaryBullet {
  const { text, n } = stripMarker(body);
  const id = n === null ? undefined : indexMap.get(n);
  return id === undefined ? { text } : { text, sourceMessageId: id };
}

/**
 * Split a trailing source marker off a line, returning ALL cited indices.
 * Reuses {@link MARKER_RE}; the leading caret/bracket is required so a bare
 * trailing number (a price, a year) stays content. Used by the Create
 * (צור) extractor, which anchors a single cell to several messages.
 */
export function splitTrailingMarkers(line: string): { text: string; indices: number[] } {
  const m = line.match(MARKER_RE);
  if (!m) return { text: line, indices: [] };
  const indices = [...m[0].matchAll(/\d+/g)].map((d) => Number.parseInt(d[0], 10));
  return { text: line.slice(0, m.index).trim(), indices };
}

/** First-index resolver kept for the summary path (one source per bullet). */
function stripMarker(line: string): { text: string; n: number | null } {
  const { text, indices } = splitTrailingMarkers(line);
  return { text, n: indices.length > 0 ? indices[0]! : null };
}

/**
 * Strip EVERY marker token from a value (not just the trailing one) and return
 * the cleaned display text + all cited indices. The Create extractor uses this so
 * inline markers (a model that tags each item in a list) and malformed pseudo-
 * markers never leak into a rendered cell, while every source id is still
 * captured. Leftover whitespace/commas left by removed tokens are tidied.
 */
/**
 * Remove every citation marker from a full markdown blob, PRESERVING structure.
 *
 * Line-wise on purpose: {@link stripAllMarkers} collapses runs of whitespace,
 * which would flatten the newlines and destroy the `##` headings and `*` bullets.
 * Here only intra-line spacing is tidied, so the markdown still renders.
 */
function stripMarkersForDisplay(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(MARKER_GLOBAL_RE, " ")
        .replace(BARE_CARET_RE, "")
        .replace(/[ \t]+([,.;:])/g, "$1") // no space before punctuation a marker left behind
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+$/, ""),
    )
    .join("\n")
    .trim();
}

export function stripAllMarkers(value: string): { text: string; indices: number[] } {
  const indices: number[] = [];
  const stripped = value
    .replace(MARKER_GLOBAL_RE, (m) => {
      for (const d of m.matchAll(/\d+/g)) indices.push(Number.parseInt(d[0], 10));
      return " ";
    })
    // Numbered markers are consumed above, so anything still carrying a caret is
    // an index-less one the model failed to complete. Cites nothing; strip it.
    .replace(BARE_CARET_RE, "");
  const text = stripped
    .replace(/\s+([,.;:])/g, "$1") // no space before punctuation a token left behind
    .replace(/([,;])(?:\s*[,;])+/g, "$1") // collapse runs of separators
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;]+|[\s,;]+$/g, "")
    .trim();
  return { text, indices };
}
