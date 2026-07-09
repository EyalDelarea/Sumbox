import { intentKey } from "./dedup-keys.js";
import type { SummaryBullet } from "./summarizer.js";

/** A meeting/todo to upsert, keyed by its source message. */
export type ExtractedItem = {
  title: string;
  owner: string | null;
  groupId: number;
  sourceMessageId: number;
  /**
   * Parsed date/time the bullet refers to (UTC) — a meeting's start or a todo's
   * due date. `null` when the text carries no date/time signal. Drives the
   * calendar event-dots + meeting times and the To-dos due badge.
   */
  when: Date | null;
  /**
   * Normalized content-identity key (see dedup-keys.ts → intentKey) for task
   * dedup: the same commitment across several messages collapses to one to-do.
   * Optional — "" / absent means "no dedup key", so the row is kept as-is.
   */
  intentKey?: string;
};

export type ExtractedEntities = {
  meetings: ExtractedItem[];
  todos: ExtractedItem[];
};

// A decision bullet is treated as a MEETING when it reads like one: a clock time,
// or a meeting/appointment keyword. Otherwise it's a TODO.
const MEETING_RE =
  /\d{1,2}:\d{2}|פגיש|מפגש|להיפגש|ביום\s|יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|מחר|מחרתיים/;

// A delimited "עד" (by/until) marks a DEADLINE — a todo's due date, not a meeting
// time — so it overrides the meeting heuristic. Bounded to avoid מועד / עדכון etc.
const DEADLINE_RE = /(?:^|[^֐-׿])עד(?![֐-׿])/;

/** Match a known participant name appearing in the bullet text → owner, else null. */
function detectOwner(text: string, participantNames: string[]): string | null {
  for (const name of participantNames) {
    if (name && name.length >= 2 && text.includes(name)) return name;
  }
  return null;
}

// ── Date parsing ────────────────────────────────────────────────────────────
//
// A small, dependency-free Hebrew date/time parser over a single bullet. Local
// (nothing leaves the box) and fully deterministic given `now`. All math is in
// UTC so it stays consistent with the front-end's UTC-day grouping/labels.

const WEEKDAYS: Record<string, number> = {
  ראשון: 0,
  שני: 1,
  שלישי: 2,
  רביעי: 3,
  חמישי: 4,
  שישי: 5,
  שבת: 6,
};

/** A keyword bounded so it isn't matched inside a longer Hebrew word. */
const bounded = (kw: string): RegExp =>
  new RegExp(`(?:^|[^\\u0590-\\u05FF])${kw}(?![\\u0590-\\u05FF])`);

// Order matters: מחרתיים before מחר (the latter is a prefix of the former).
const REL_DAYS: Array<[RegExp, number]> = [
  [bounded("מחרתיים"), 2],
  [bounded("מחר"), 1],
  [bounded("היום"), 0],
];

// HH:MM not embedded in a longer run of digits ("ב-14:00" → 14:00).
const CLOCK_RE = /(?:^|[^0-9])([01]?\d|2[0-3]):([0-5]\d)(?![0-9])/;

/**
 * Parse a date/time the bullet refers to, relative to `now` (UTC). Recognizes
 * מחר/מחרתיים/היום, weekday names (with or without a יום/ביום prefix → the next
 * occurrence), and an HH:MM clock time. Returns `null` when no signal is present.
 * A day signal without a clock → that day at 00:00 UTC; a clock without a day →
 * today at that time.
 */
export function parseHebrewWhen(text: string, now: Date = new Date()): Date | null {
  const todayDow = now.getUTCDay();
  let dayOffset: number | null = null;

  for (const [re, off] of REL_DAYS) {
    if (re.test(text)) {
      dayOffset = off;
      break;
    }
  }
  if (dayOffset === null) {
    for (const [name, dow] of Object.entries(WEEKDAYS)) {
      if (bounded(name).test(text)) {
        dayOffset = (dow - todayDow + 7) % 7;
        break;
      }
    }
  }

  const clock = CLOCK_RE.exec(text);
  if (dayOffset === null && !clock) return null;

  const hh = clock ? Number(clock[1]) : 0;
  const mm = clock ? Number(clock[2]) : 0;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (dayOffset ?? 0), hh, mm),
  );
}

/**
 * Map a structured summary's `decisions[]` bullets into meeting/todo rows for one
 * chat. Pure + deterministic: only bullets that carry a `sourceMessageId` become
 * rows (so they dedup + jump to source); a clock-time/meeting-keyword bullet is a
 * meeting, the rest are todos. `owner` is a known participant name found in the
 * text, when any.
 */
export function extractEntities(
  decisions: SummaryBullet[],
  groupId: number,
  participantNames: string[] = [],
  now: Date = new Date(),
): ExtractedEntities {
  const meetings: ExtractedItem[] = [];
  const todos: ExtractedItem[] = [];
  for (const b of decisions) {
    const title = b.text.trim();
    if (!title || b.sourceMessageId === undefined) continue;
    const item: ExtractedItem = {
      title,
      owner: detectOwner(title, participantNames),
      groupId,
      sourceMessageId: b.sourceMessageId,
      when: parseHebrewWhen(title, now),
      intentKey: intentKey(title),
    };
    const isMeeting = MEETING_RE.test(title) && !DEADLINE_RE.test(title);
    (isMeeting ? meetings : todos).push(item);
  }
  return { meetings, todos };
}
