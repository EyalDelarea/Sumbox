/**
 * time.js — Pure time/date helper utilities for the WhatsApp-Sum web UI.
 *
 * Browser ES module (plain JS, no TypeScript, no DOM dependencies).
 * All functions are pure and deterministic — pass `now` explicitly for testability.
 *
 * Hebrew wording choices:
 *   < 1 min  → "ממש עכשיו"          (just now)
 *   < 60 min → "לפני N דק׳"         (N minutes ago)
 *   = 1 hour → "לפני שעה"           (an hour ago — special singular form)
 *   < 24 h   → "לפני N שעות"        (N hours ago)
 *   = 1 day  → "אתמול"              (yesterday)
 *   > 1 day  → "לפני N ימים"        (N days ago)
 */

/**
 * Format an ISO timestamp as a Hebrew relative-time string.
 *
 * @param {string|null|undefined} iso - ISO 8601 timestamp string
 * @param {number} [now=Date.now()]   - Reference epoch ms (injectable for tests)
 * @returns {string|null}             - Hebrew string, or null for null/undefined/invalid/future
 */
export function formatAgo(iso, now = Date.now()) {
  if (iso == null || iso === "") return null;

  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;

  const diffMs = now - ts;
  if (diffMs < 0) return null; // future timestamp

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / (60 * 60_000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60_000));

  if (diffSec < 60) return "ממש עכשיו";
  if (diffMin < 60) return `לפני ${diffMin} דק׳`;
  if (diffHours === 1) return "לפני שעה";
  if (diffHours < 24) return `לפני ${diffHours} שעות`;
  if (diffDays === 1) return "אתמול";
  return `לפני ${diffDays} ימים`;
}

/**
 * Convert a named time preset to an ISO cutoff string (start of the window).
 *
 * @param {"24h"|"3d"|"week"|"month"} preset
 * @param {number} [now=Date.now()] - Reference epoch ms
 * @returns {string} ISO 8601 string representing (now - offset)
 * @throws {Error} For unknown preset values (document choice: throw, not null)
 */
export function presetToSince(preset, now = Date.now()) {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const offsets = {
    "24h": 24 * HOUR,
    "3d": 3 * DAY,
    "week": 7 * DAY,
    "month": 30 * DAY,
  };

  const offset = offsets[preset];
  if (offset === undefined) {
    throw new Error(`Unknown preset: "${preset}". Valid values are: 24h, 3d, week, month`);
  }

  return new Date(now - offset).toISOString();
}

/**
 * Validate user range-picker input and normalise it into a canonical form.
 *
 * @param {{ mode: string, n?: number, datetime?: string }} input
 * @param {number} [now=Date.now()] - Reference epoch ms (injectable for tests)
 * @returns {{ ok: true, last?: number, since?: string } | { ok: false, error: string }}
 *
 * Mode "last":
 *   - n must be a positive integer (typeof number, > 0, Number.isInteger)
 *   - returns { ok: true, last: n }
 *
 * Mode "since":
 *   - datetime must be a non-empty parseable date string not in the future
 *   - returns { ok: true, since: <ISO string> }
 *
 * Mode "sumbox":
 *   - always valid, no extra fields required
 *   - returns { ok: true }
 *
 * Error messages are in Hebrew.
 */
export function validateRangeInput(input, now = Date.now()) {
  const { mode, n, datetime } = input;

  if (mode === "sumbox") {
    return { ok: true };
  }

  if (mode === "last") {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: "יש להזין מספר שלם חיובי של הודעות" };
    }
    return { ok: true, last: n };
  }

  if (mode === "since") {
    if (!datetime || datetime === "") {
      return { ok: false, error: "יש לבחור תאריך ושעה" };
    }

    const ts = Date.parse(datetime);
    if (Number.isNaN(ts)) {
      return { ok: false, error: "תאריך לא תקין" };
    }

    if (ts > now) {
      return { ok: false, error: "לא ניתן לבחור תאריך עתידי" };
    }

    return { ok: true, since: new Date(ts).toISOString() };
  }

  // Unrecognised mode — treat as invalid
  return { ok: false, error: "מצב לא מוכר" };
}
