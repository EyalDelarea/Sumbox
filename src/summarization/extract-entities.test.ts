import { describe, expect, it } from "vitest";
import { extractEntities, parseHebrewWhen } from "./extract-entities.js";
import type { SummaryBullet } from "./summarizer.js";

const b = (text: string, sourceMessageId?: number): SummaryBullet =>
  sourceMessageId === undefined ? { text } : { text, sourceMessageId };

// Wed 2026-06-10 09:00 UTC — a fixed "now" so relative-date parsing is deterministic.
const NOW = new Date("2026-06-10T09:00:00.000Z");
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

describe("parseHebrewWhen", () => {
  it("resolves מחר / מחרתיים / היום relative to now (UTC day)", () => {
    expect(iso(parseHebrewWhen("נדבר מחר", NOW))).toBe("2026-06-11T00:00:00.000Z");
    expect(iso(parseHebrewWhen("נסיים מחרתיים", NOW))).toBe("2026-06-12T00:00:00.000Z");
    expect(iso(parseHebrewWhen("צריך היום", NOW))).toBe("2026-06-10T00:00:00.000Z");
  });

  it("combines a relative day with a clock time", () => {
    expect(iso(parseHebrewWhen("פגישה מחר ב-14:00", NOW))).toBe("2026-06-11T14:00:00.000Z");
  });

  it("resolves a weekday name to its next occurrence (incl. ביום prefix)", () => {
    // Wed → next Thursday is tomorrow (06-11); next Sunday is 06-14.
    expect(iso(parseHebrewWhen("ביום חמישי", NOW))).toBe("2026-06-11T00:00:00.000Z");
    expect(iso(parseHebrewWhen("ניפגש ביום ראשון 09:30", NOW))).toBe("2026-06-14T09:30:00.000Z");
    expect(iso(parseHebrewWhen("חמישי", NOW))).toBe("2026-06-11T00:00:00.000Z");
  });

  it("resolves a bare clock time to today", () => {
    expect(iso(parseHebrewWhen("נתראה ב-16:45", NOW))).toBe("2026-06-10T16:45:00.000Z");
  });

  it("returns null when there is no date or time signal", () => {
    expect(parseHebrewWhen("לבדוק את השרת", NOW)).toBeNull();
  });

  it("does not false-match a weekday substring inside another word", () => {
    // שנייה contains שני but is not a delimited weekday token.
    expect(parseHebrewWhen("פעם שנייה לבדוק", NOW)).toBeNull();
  });
});

describe("extractEntities", () => {
  it("classifies a clock-time / meeting-keyword bullet as a meeting, rest as todos", () => {
    const decisions = [
      b("פגישה ביום חמישי 14:00 במשרד", 10),
      b("לשלוח את הדוח לדנה", 11),
      b("להיפגש עם הספק", 12),
    ];
    const { meetings, todos } = extractEntities(decisions, 5);
    expect(meetings.map((m) => m.sourceMessageId)).toEqual([10, 12]);
    expect(todos.map((t) => t.sourceMessageId)).toEqual([11]);
    expect(meetings[0]).toMatchObject({ groupId: 5, title: "פגישה ביום חמישי 14:00 במשרד" });
  });

  it("keeps a deadline to-do out of Meetings even with a clock/day keyword", () => {
    // "עד" marks a deadline — this is a due date, not a meeting at 18:00.
    const { meetings, todos } = extractEntities([b("לשלם עד מחר ב-18:00", 40)], 5, [], NOW);
    expect(meetings).toEqual([]);
    expect(todos.map((t) => t.sourceMessageId)).toEqual([40]);
    expect(iso(todos[0]?.when ?? null)).toBe("2026-06-11T18:00:00.000Z");
  });

  it("does not treat עד inside a word (מועד / עדכון) as a deadline", () => {
    // A real meeting keyword + clock with no delimited עד → stays a meeting.
    const { meetings } = extractEntities([b("מועד הפגישה 10:00", 41)], 5, [], NOW);
    expect(meetings.map((m) => m.sourceMessageId)).toEqual([41]);
  });

  it("drops bullets without a sourceMessageId (can't dedup or jump)", () => {
    const { meetings, todos } = extractEntities([b("משימה ללא מקור")], 5);
    expect(meetings).toEqual([]);
    expect(todos).toEqual([]);
  });

  it("detects a known participant name as the owner", () => {
    const { todos } = extractEntities([b("דנה צריכה לאשר את התקציב", 20)], 5, ["דנה", "יוסי"]);
    expect(todos[0]?.owner).toBe("דנה");
  });

  it("leaves owner null when no known name appears", () => {
    const { todos } = extractEntities([b("לבדוק את השרת", 21)], 5, ["דנה"]);
    expect(todos[0]?.owner).toBeNull();
  });

  it("attaches the parsed date to the item (meeting start / todo due)", () => {
    const { meetings } = extractEntities([b("פגישה מחר 14:00", 30)], 5, [], NOW);
    expect(iso(meetings[0]?.when ?? null)).toBe("2026-06-11T14:00:00.000Z");
  });

  it("leaves when null on a dateless bullet", () => {
    const { todos } = extractEntities([b("לבדוק את השרת", 31)], 5, [], NOW);
    expect(todos[0]?.when).toBeNull();
  });
});
