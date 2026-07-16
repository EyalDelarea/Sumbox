import { describe, expect, it } from "vitest";
import { NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC } from "../ask/prompt.js";
import { detectRefusal, refused } from "./denial.js";

/**
 * Fixtures are REAL @Aida outputs captured from ask-sandbox runs and the
 * citation spikes against group 70 on 2026-07-16 — not invented Hebrew. They are
 * her own generated text (no group member's message content), so this file is
 * safe to commit and runs in CI with no corpus and no model.
 */

describe("detectRefusal — canonical constants", () => {
  it("detects NOT_IN_CHAT verbatim as a full refusal", () => {
    expect(detectRefusal(`תכף תכף... ${NOT_IN_CHAT}`)).toEqual({
      kind: "not_in_chat",
      degree: "full",
    });
  });

  it("detects OFF_TOPIC verbatim (observed emitted exactly)", () => {
    expect(detectRefusal(`תכף תכף... ${OFF_TOPIC}`)).toEqual({
      kind: "off_topic",
      degree: "full",
    });
  });

  it("detects NOT_INDEXED and does NOT mislabel it not_in_chat", () => {
    // Critical: an honest "I can't see yet" must never count as a false denial.
    expect(detectRefusal(`תכף תכף... ${NOT_INDEXED}`)).toEqual({
      kind: "not_indexed",
      degree: "full",
    });
  });
});

describe("detectRefusal — real paraphrases (gemma4 rewrites NOT_IN_CHAT)", () => {
  it.each([
    "תכף תכף... לא מצאתי ששאלו אותי שאלה אישית בקבוצה.",
    "תכף תכף... לא מצאתי את זה בשיחה.",
    "תכף תכף... לא מצאתי הודעה כזו בשיחה.",
    "תכף תכף... לא מצאתי שום אזכור לכך ששיחות פנו אליי בשיחה הזאת.",
    "תכף תכף... לא מצאתי התייחסות להודעה הזו בשיחה.",
  ])("classifies a real paraphrase as not_in_chat: %s", (answer) => {
    expect(detectRefusal(answer)?.kind).toBe("not_in_chat");
  });

  it("grades a refusal carrying substantive content as partial", () => {
    // Real output: denies, but also reports what Royi actually said.
    const answer =
      "תכף תכף... לא מצאתי הודעה כזו בשיחה, רק שרועי שאל אם חלק מהשיחות פנו אליי או אם מישהו שאל אותי משהו.";
    expect(detectRefusal(answer)).toEqual({ kind: "not_in_chat", degree: "partial" });
  });

  it("grades a bare refusal as full", () => {
    expect(detectRefusal("תכף תכף... לא מצאתי את זה בשיחה.")?.degree).toBe("full");
  });

  // ── Regressions found by validating against 30 real replies ───────────────

  it("catches 'לא נמצאה הודעה' — word order varies, so the marker can't assume one", () => {
    const answer =
      "תכף תכף... לא נמצאה הודעה בשיחה המסבירה מדוע גיא לא חידש לך את ה-usage. מה שנאמר הוא שהשירות הופסק.";
    expect(detectRefusal(answer)?.kind).toBe("not_in_chat");
  });

  it("prefers not_in_chat over off_topic in a MIXED reply", () => {
    // The factual claim about the conversation is the primary refusal and the one
    // the headline metric tracks; calling this off_topic hides a false denial.
    const answer = "תכף תכף... לא מצאתי התייחסות להודעה הזו בשיחה. אני עונה רק על מה שנאמר בקבוצה.";
    expect(detectRefusal(answer)?.kind).toBe("not_in_chat");
  });

  it("grades content in a SEPARATE sentence as partial (no adversative present)", () => {
    const answer =
      "תכף תכף... אני אידה, חברה בקבוצה הזו. לגבי השאלה אם שאלו אותי כלום – לא מצאתי בשיחה ששאלו אותי משהו.";
    expect(detectRefusal(answer)).toEqual({ kind: "not_in_chat", degree: "partial" });
  });

  it("still grades a merely VERBOSE denial as full (adds no information)", () => {
    const answer = "תכף תכף... לא מצאתי בשיחה מישהו בשם רועי או אזכור של מה שהוא רוצה.";
    expect(detectRefusal(answer)).toEqual({ kind: "not_in_chat", degree: "full" });
  });

  it("keeps a pure off_topic classified as off_topic/full", () => {
    expect(detectRefusal(`תכף תכף... ${OFF_TOPIC}`)).toEqual({
      kind: "off_topic",
      degree: "full",
    });
  });
});

describe("detectRefusal — non-refusals must not false-positive", () => {
  it.each([
    // Real output: she actually answered.
    "תכף תכף... לפי ההודעות בקבוצה, רועי שאל אם חלק מהשיחות פנו אליי.",
    "תכף תכף... אני אידה, חברה בקבוצה הזו.",
    "תכף תכף... רועי אמר שהוא מקצוען.",
  ])("returns null for a real answered reply: %s", (answer) => {
    expect(detectRefusal(answer)).toBeNull();
    expect(refused(answer)).toBe(false);
  });

  it("does not fire on 'מצאתי' without the negation", () => {
    expect(detectRefusal("תכף תכף... מצאתי את זה בשיחה, רועי כתב על זה.")).toBeNull();
  });
});

describe("detectRefusal — normalization robustness", () => {
  it("detects a refusal carrying an invisible bidi mark inside the phrase", () => {
    expect(detectRefusal("תכף תכף... לא‏ מצאתי את זה בשיחה.")?.kind).toBe("not_in_chat");
  });

  it("detects a refusal written with niqqud", () => {
    expect(detectRefusal("תכף תכף... לֹא מָצָאתִי את זה בשיחה.")?.kind).toBe("not_in_chat");
  });

  it("detects a refusal with no persona prefix", () => {
    expect(detectRefusal("לא מצאתי את זה בשיחה.")?.kind).toBe("not_in_chat");
  });
});
