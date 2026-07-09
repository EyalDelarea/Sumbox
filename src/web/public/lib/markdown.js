/**
 * markdown.js — Minimal, safe Markdown-to-HTML renderer for WhatsApp-Sum summary cards.
 *
 * Browser ES module (plain JS, no TypeScript, no DOM dependencies, no external libraries).
 * Pure function — deterministic, safe to unit-test in Node.
 *
 * Supported subset:
 *   ## heading   → <h3>
 *   ### heading  → <h4>
 *   **bold**     → <strong>
 *   - item / * item (consecutive lines) → <ul><li>…</li></ul>
 *   blank-line-separated blocks → <p>…</p>
 *   single \n inside a block → <br>
 *   plain prose → <p>
 *   empty/whitespace → ""
 *
 * Security: HTML is escaped FIRST (FR-010) so no raw model output becomes live markup.
 */

/**
 * Escape HTML special characters so model/user text is never interpreted as markup.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Apply inline transforms (bold) to an already-escaped string.
 *
 * @param {string} text - HTML-escaped text
 * @returns {string}
 */
function applyInline(text) {
  // **bold** → <strong>bold</strong> (non-greedy, within a line)
  const bolded = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // [Chat name] → bidi-isolated chip. In RTL Hebrew text an inline bracketed
  // tag (often a Latin name with emoji/dates) gets mirrored and scrambled by
  // the bidi algorithm — the brackets flip and the run breaks the line. <bdi>
  // isolates the run so it renders correctly, and the chip styling visually
  // separates "which chat" from "what happened". The literal brackets are
  // dropped in favour of the chip. Applied after bold so it never splits a
  // <strong> tag.
  return bolded.replace(/\[([^\]\n]+)\]/g, '<bdi class="chat-tag">$1</bdi>');
}

/**
 * Strip the inline source-citation markers the model emits. It is INCONSISTENT
 * about the format, so we handle every numeric variant we've seen leak:
 *   - bracketed, hash-prefixed: `^[#3, #5]`, `[#1], [#2]`   (the original form)
 *   - bracketed, bare numbers:  `[31]`, `[32, 33]`          (these were slipping
 *     past the old `[#…]`-only strip and rendering as green `.chat-tag` chips —
 *     `applyInline` turns any surviving `[…]` into a chip)
 *   - caret, no brackets:       `^242`, `^131, 185`, `^#4, #5`
 * The product surfaces sources via the tappable `.src` / `.sum-jump` affordance
 * (which carries the real messageId), so these raw numbers are noise the design
 * never shows — drop them, with any leading caret and the comma joiners between a
 * run of them.
 *
 * Only PURELY-NUMERIC bracket contents are touched, so real chat tags
 * (`[Bar Hevr]`, `[Flopi 06.06.26 🎉]`) survive for the chat-tag chip. Bare prose
 * numbers ("כ-290 אלף") are untouched — a marker must be bracketed or caret-led.
 *
 * @param {string} text - already HTML-escaped text
 * @returns {string}
 */
function stripCitations(text) {
  // Each marker is matched on its own (the `g` flag handles repeated/adjacent
  // ones) and the inner number list is comma-ANCHORED (`(?:,\s*#?\d+)*`) so
  // there is no ambiguous `\s*` repetition — i.e. linear, no catastrophic
  // backtracking (CodeQL `js/redos`).
  return (
    text
      // Bracketed numeric refs (optional leading caret / `#`): [31], [32, 33], ^[#3, #5].
      .replace(/\^?\[#?\d+(?:,\s*#?\d+)*\]/g, "")
      // Bare caret refs with no brackets: ^242, ^131, 185.
      .replace(/\^#?\d+(?:,\s*#?\d+)*/g, "")
      // A removed marker can strand whitespace before punctuation, or a joiner
      // comma between two markers — tidy those so the prose reads naturally.
      .replace(/ +([,.;:])/g, "$1")
      .replace(/,(\s*[.;:])/g, "$1")
      .replace(/ {2,}/g, " ")
  );
}

/** Known Hebrew section headers → their WhatsApp-copy emoji prefix. Unknown headings get no emoji. */
const HEADING_EMOJI = {
  תקציר: "📝",
  "נושאים עיקריים": "📌",
  "החלטות ומשימות": "✅",
  "שאלות פתוחות": "❓",
  "לפי משתתף": "👤",
};

/**
 * Convert raw summary Markdown into WhatsApp-native plain text for the copy
 * button. WhatsApp has no header markup and only single-asterisk bold, so the
 * in-app renderer's HTML output is unusable as a paste target — this instead
 * transforms the raw markdown string directly:
 *   - citation markers stripped (reuses {@link stripCitations})
 *   - `## כותרת` → an emoji (known headers) + `*כותרת*` on its own line
 *   - `**bold**` → `*bold*` (WhatsApp's single-asterisk bold)
 *   - `- `/`* ` bullets → `• `
 *   - 3+ blank lines collapsed to 1
 *
 * Pure function — does not touch the stored/rendered `overview`; call only at
 * copy time.
 *
 * @param {string} md - raw summary markdown (e.g. `detailState.summaryText`)
 * @returns {string} WhatsApp-native plain text; empty string for empty input
 */
export function toWhatsAppText(md) {
  if (md == null || String(md).trim() === "") return "";

  const noCitations = stripCitations(String(md));

  const lines = noCitations.split("\n").map((line) => {
    const headingMatch = line.match(/^(#{2,3})\s+(.*)$/);
    if (headingMatch) {
      const title = headingMatch[2].trim();
      const emoji = HEADING_EMOJI[title];
      return emoji ? `${emoji} *${title}*` : `*${title}*`;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      return `• ${line.slice(2)}`;
    }
    return line;
  });

  return lines
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Render a single line of inline Markdown (bold + chat tags) to safe HTML, with
 * citation markers stripped. Use for text that lives inside its own element (a
 * summary bullet `<li>`, a card line) where the block-level wrapping of
 * {@link renderMarkdown} (`<p>`/`<ul>`) would be wrong.
 *
 * @param {string} text - raw single-line text (may contain model output)
 * @returns {string} - safe inline HTML; empty string for empty input
 */
export function renderInline(text) {
  if (text == null || String(text).trim() === "") return "";
  return applyInline(stripCitations(escapeHtml(String(text))));
}

/**
 * Render a block of lines (no blank-line gaps within) to HTML.
 * The lines are already HTML-escaped.
 *
 * @param {string[]} lines
 * @returns {string}
 */
/** A GFM separator row: `|---|:--:|`, pipes + dashes/colons only, at least one dash. */
function isSeparatorRow(l) {
  return l.includes("|") && /-/.test(l) && /^[\s|:-]+$/.test(l);
}

/** Split a `| a | b |` row into trimmed cell strings (outer pipes optional). */
function splitCells(l) {
  let s = l.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderTable(header, rows) {
  const ths = splitCells(header)
    .map((c) => `<th>${applyInline(c)}</th>`)
    .join("");
  const body = rows
    .map((r) => `<tr>${splitCells(r).map((c) => `<td>${applyInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md-tablewrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBlock(lines) {
  if (lines.length === 0) return "";

  // Table: a `|---|` separator row whose preceding line is the header. The model
  // often omits the blank line before a table, so detect it anywhere in a block —
  // prose before/after is rendered as its own block.
  const sepIdx = lines.findIndex((l, i) => i >= 1 && isSeparatorRow(l) && lines[i - 1].includes("|"));
  if (sepIdx >= 1) {
    const header = lines[sepIdx - 1];
    let end = sepIdx + 1;
    while (end < lines.length && lines[end].includes("|")) end++;
    const before = lines.slice(0, sepIdx - 1);
    const rows = lines.slice(sepIdx + 1, end);
    const after = lines.slice(end);
    return renderBlock(before) + renderTable(header, rows) + renderBlock(after);
  }

  // Heading: single-line block starting with ## or ###
  if (lines.length === 1) {
    const line = lines[0];
    if (line.startsWith("### ")) {
      return `<h4>${applyInline(line.slice(4))}</h4>`;
    }
    if (line.startsWith("## ")) {
      return `<h3>${applyInline(line.slice(3))}</h3>`;
    }
  }

  // Check if ALL lines in the block are bullet items
  const isBullet = (l) => l.startsWith("- ") || l.startsWith("* ");
  if (lines.every(isBullet)) {
    const items = lines.map((l) => `<li>${applyInline(l.slice(2))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }

  // Mixed block: may start with a heading line followed by prose/bullets.
  // Split into sub-blocks separated by heading lines, re-render each.
  // For simplicity: if the first line is a heading, emit it then render the rest.
  const firstLine = lines[0];
  if (firstLine.startsWith("### ") || firstLine.startsWith("## ")) {
    const heading = renderBlock([firstLine]);
    const rest = renderBlock(lines.slice(1));
    return heading + rest;
  }

  // Paragraph: join with <br> for single newlines
  const inner = lines.map((l) => applyInline(l)).join("<br>");
  return `<p>${inner}</p>`;
}

/**
 * Convert a minimal Markdown subset to a safe HTML string.
 *
 * @param {string} md - Raw markdown string (may contain model output or plain prose)
 * @returns {string}  - Safe HTML string; empty string for empty/whitespace-only input
 */
export function renderMarkdown(md) {
  if (!md || md.trim() === "") return "";

  // 1. Escape HTML FIRST — nothing from md reaches the DOM as raw markup
  const escaped = escapeHtml(md);

  // 2. Drop inline source-citation markers (`^[#3, #5]`) — the source-jump
  //    affordance carries the real messageId, so these raw numbers are noise.
  const cleaned = stripCitations(escaped);

  // 3. Split into blank-line-separated blocks
  const rawBlocks = cleaned.split(/\n{2,}/);

  const parts = [];

  for (const rawBlock of rawBlocks) {
    const lines = rawBlock
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);

    if (lines.length === 0) continue;

    // If a block mixes bullet and non-bullet lines, or heading + bullets,
    // split at heading-starting lines so each sub-block is homogeneous.
    const subBlocks = [];
    let current = [];

    for (const line of lines) {
      const isHeading = line.startsWith("## ") || line.startsWith("### ");
      if (isHeading && current.length > 0) {
        subBlocks.push(current);
        current = [line];
      } else if (isHeading) {
        current = [line];
        subBlocks.push(current);
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) subBlocks.push(current);

    for (const sub of subBlocks) {
      const rendered = renderBlock(sub);
      if (rendered) parts.push(rendered);
    }
  }

  return parts.join("");
}
