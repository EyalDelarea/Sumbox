// ── Settings view-logic (pure) ──────────────────────────
//
// Deterministic helpers over the /api/preferences payload, kept out of the DOM
// layer so they can be unit-tested. The digest-times picker: CSV ⇄ selected
// HH:MM chips.

/** The four digest-time chips offered by the picker (§8 / §1 step-4). */
export const DIGEST_CHOICES = ["07:00", "08:00", "09:00", "20:00"];

/**
 * Parse a digest-times CSV into a normalized, sorted, deduped list of HH:MM
 * strings. Malformed entries (non HH:MM, hour > 23, minute > 59) are dropped.
 * Lexical sort is correct because the values are zero-padded.
 * @param {string} csv
 * @returns {string[]}
 */
export function parseDigestCsv(csv) {
  const seen = new Set();
  const out = [];
  for (const raw of String(csv ?? "").split(",")) {
    const t = raw.trim();
    if (!/^\d{2}:\d{2}$/.test(t)) continue;
    const h = Number(t.slice(0, 2));
    const m = Number(t.slice(3, 5));
    if (h > 23 || m > 59) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.sort();
}

/** Is a given HH:MM currently part of the digest CSV? */
export function isDigestSelected(csv, value) {
  return parseDigestCsv(csv).includes(value);
}

/**
 * Toggle one HH:MM in the digest CSV, preserving every other (including
 * non-choice) time already present. Never returns an empty CSV: deselecting
 * the last remaining time is refused (the input is returned unchanged) so we
 * only ever PUT a valid non-empty spec.
 * @param {string} csv
 * @param {string} value - an HH:MM string
 * @returns {string} the new CSV
 */
export function toggleDigestTime(csv, value) {
  const times = parseDigestCsv(csv);
  const idx = times.indexOf(value);
  if (idx >= 0) {
    if (times.length === 1) return times.join(","); // refuse to empty the spec
    times.splice(idx, 1);
  } else {
    times.push(value);
    times.sort();
  }
  return times.join(",");
}
