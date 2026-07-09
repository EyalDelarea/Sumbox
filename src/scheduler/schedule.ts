/**
 * Pure scheduler time functions — no DB, no Date.now(), no timers.
 *
 * T010: parseTimes, nextRun
 * T024: dueSumbox
 */

export type TimeSlot = { h: number; m: number };

/**
 * Parse a comma-separated HH:MM string into a sorted, deduplicated list of
 * time slots.
 *
 * Throws on malformed entries (non HH:MM, h > 23, m > 59).
 */
export function parseTimes(spec: string): TimeSlot[] {
  const entries = spec.split(",").map((s) => s.trim());
  const seen = new Set<string>();
  const result: TimeSlot[] = [];

  for (const entry of entries) {
    const match = /^(\d{2}):(\d{2})$/.exec(entry);
    if (!match) {
      throw new Error(`Invalid time slot "${entry}": expected HH:MM format`);
    }
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23) {
      throw new Error(`Invalid hour ${h} in slot "${entry}": must be 0-23`);
    }
    if (m > 59) {
      throw new Error(`Invalid minute ${m} in slot "${entry}": must be 0-59`);
    }
    const key = `${h}:${m}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ h, m });
    }
  }

  // Sort by hour then minute
  result.sort((a, b) => a.h - b.h || a.m - b.m);
  return result;
}

/**
 * Construct a Date for the given time slot on the given local date.
 */
function slotOnDate(date: Date, slot: TimeSlot): Date {
  const d = new Date(date);
  d.setHours(slot.h, slot.m, 0, 0);
  return d;
}

/**
 * Returns the soonest slot instant >= now (local timezone).
 *
 * If all of today's slots have passed, returns the first slot tomorrow.
 * now is injected — never calls Date.now() internally.
 */
export function nextRun(now: Date, times: TimeSlot[]): Date {
  // Try each slot today
  for (const slot of times) {
    const candidate = slotOnDate(now, slot);
    if (candidate >= now) {
      return candidate;
    }
  }

  // All slots passed today — use first slot tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return slotOnDate(tomorrow, times[0]!);
}

/**
 * Returns true iff at least one scheduled slot instant lies in (lastRun, now].
 *
 * - lastRun == null (first ever start) → always true (warm on startup).
 * - Guarantees at-most-once when caller records the run before restarting.
 */
export function dueSumbox(now: Date, lastRun: Date | null, times: TimeSlot[]): boolean {
  if (lastRun === null) {
    return true;
  }

  // Walk all slot instants up to (and including) now, looking for one that
  // is strictly after lastRun.
  //
  // Strategy: enumerate slot instants starting from the day of lastRun and
  // continue until we exceed now. We need to check from the same calendar
  // day as lastRun because a slot on that day may fall in the range.

  const startDate = new Date(lastRun);
  startDate.setHours(0, 0, 0, 0); // midnight of lastRun's day

  const endDate = new Date(now);
  endDate.setHours(0, 0, 0, 0); // midnight of now's day

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysDiff = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);

  for (let d = 0; d <= daysDiff; d++) {
    const dayBase = new Date(startDate);
    dayBase.setDate(dayBase.getDate() + d);

    for (const slot of times) {
      const slotInstant = slotOnDate(dayBase, slot);
      if (slotInstant > lastRun && slotInstant <= now) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolve the digest time slots for a tenant: the stored per-tenant `digest_times`
 * (CSV HH:MM) when present and valid, otherwise the env default (`DIGEST_TIMES`).
 * A null/empty/malformed stored value falls back to the env default — the
 * single-user zero-config guardrail. Pure.
 */
export function resolveDigestTimes(stored: string | null, envDefault: string): TimeSlot[] {
  if (stored !== null && stored.trim() !== "") {
    try {
      const slots = parseTimes(stored);
      if (slots.length > 0) return slots;
    } catch {
      // malformed stored value → fall back to the env default
    }
  }
  return parseTimes(envDefault);
}
