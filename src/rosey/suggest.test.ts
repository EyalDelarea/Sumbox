import { describe, expect, it } from "vitest";
import type { RoseySourceMessage } from "../db/repositories/rosey-tasks.js";
import { buildSuggestPrompt, parseSuggestions } from "./suggest.js";

const msg = (id: number, content: string, extra: Partial<RoseySourceMessage> = {}) => ({
  messageId: id,
  sentAt: new Date("2026-11-01T08:00:00Z"),
  sender: "דנה",
  content,
  isVoice: false,
  ...extra,
});

const batch = [msg(10, "צריך חלב וביצים"), msg(11, "תיקנתי את הברז")];

describe("buildSuggestPrompt", () => {
  it("puts the future-action rule first and cites every message by id", () => {
    const p = buildSuggestPrompt(batch);
    expect(p.startsWith("RULE 1.")).toBe(true);
    expect(p).toContain("[10] 2026-11-01 דנה: צריך חלב וביצים");
    expect(p).toContain("[11] 2026-11-01");
  });

  it("flattens multi-line messages, marks voice notes, and never shows a raw JID", () => {
    const p = buildSuggestPrompt([msg(12, "חלב\nביצים", { isVoice: true, sender: "123@lid" })]);
    expect(p).toContain("[12] 2026-11-01 משתתף לא ידוע (voice note): חלב / ביצים");
  });
});

describe("parseSuggestions", () => {
  it("keeps only kind=task, indexes list items per message in order", () => {
    const reply = JSON.stringify({
      items: [
        { m: 10, kind: "task", text: "לקנות חלב" },
        { m: 10, kind: "task", text: "לקנות ביצים" },
        { m: 11, kind: "past", text: "לתקן את הברז" },
      ],
    });
    const out = parseSuggestions(reply, batch);
    expect(out?.items).toEqual([
      { sourceMessageId: 10, itemIndex: 0, title: "לקנות חלב" },
      { sourceMessageId: 10, itemIndex: 1, title: "לקנות ביצים" },
    ]);
    expect(out?.droppedByKind).toEqual({ past: 1 });
  });

  it("rejects a citation to a message outside the batch (an invented id)", () => {
    const out = parseSuggestions('{"items":[{"m":999,"kind":"task","text":"x"}]}', batch);
    expect(out?.items).toEqual([]);
    expect(out?.rejected).toEqual({ unknown_message_id: 1 });
  });

  it("rejects malformed candidates by reason instead of failing the batch", () => {
    const out = parseSuggestions(
      '{"items":[7, {"m":10,"kind":"chore","text":"x"}, {"m":"10","kind":"task","text":"  "}]}',
      batch,
    );
    expect(out?.rejected).toEqual({ not_an_object: 1, bad_kind: 1, empty_text: 1 });
  });

  it("skips a trailing object without items and takes the last one that has them", () => {
    const reply = `{"items": [{"m": 10, "kind": "task", "text": "לקנות חלב"}]}
Notes: {"confidence": "high"}`;
    expect(parseSuggestions(reply, batch)?.items).toEqual([
      { sourceMessageId: 10, itemIndex: 0, title: "לקנות חלב" },
    ]);
  });

  it("skips a trailing object whole, never taking an array nested inside it", () => {
    const reply = `{"items": [{"m": 10, "kind": "task", "text": "לקנות חלב"}]} {"tags": ["x"]}`;
    expect(parseSuggestions(reply, batch)).toMatchObject({
      items: [{ sourceMessageId: 10, title: "לקנות חלב" }],
      rejected: {},
    });
  });

  it("accepts a bare array and a string id", () => {
    const out = parseSuggestions('[{"m":"10","kind":"task","text":"לקנות חלב"}]', batch);
    expect(out?.items).toHaveLength(1);
  });

  it("returns null when the reply has no usable JSON — a batch failure, not zero tasks", () => {
    expect(parseSuggestions("I could not find any tasks.", batch)).toBeNull();
    expect(parseSuggestions('{"tasks":[]}', batch)).toBeNull();
  });
});
