import { describe, expect, it } from "vitest";
import { containsPhrase, containsStem, normalizeHebrew, stemPattern } from "./hebrew.js";

// Synthetic fixtures only — no corpus, no model. This file must run in CI.

describe("normalizeHebrew", () => {
  it("strips niqqud so pointed and unpointed text compare equal", () => {
    expect(normalizeHebrew("מָצָאתִי")).toBe(normalizeHebrew("מצאתי"));
  });

  it("strips bidi controls hiding INSIDE a phrase", () => {
    // The classic RTL eval bug: this renders identically but breaks a naive regex.
    const withRlm = "לא‏מצאתי";
    expect(normalizeHebrew(withRlm)).toBe("לאמצאתי");
    expect(containsPhrase("לא‏ מצאתי את זה", "לא מצאתי")).toBe(true);
  });

  it("strips zero-width joiners left by emoji sequences", () => {
    // ...ם folds to מ as well; this asserts the ZWJ/BOM are gone, not the fold.
    expect(normalizeHebrew("שלום‍﻿")).toBe("שלומ");
  });

  it("folds final forms so a stem matches word-final letters", () => {
    expect(normalizeHebrew("שלום")).toBe("שלומ");
    expect(normalizeHebrew("ךםןףץ")).toBe("כמנפצ");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeHebrew("  לא   מצאתי \n את זה ")).toBe("לא מצאתי את זה");
  });

  it("is idempotent", () => {
    const once = normalizeHebrew("מָצָאתִי‏  שלום");
    expect(normalizeHebrew(once)).toBe(once);
  });

  it("leaves latin, digits and emoji intact (WhatsApp is mixed-script)", () => {
    expect(normalizeHebrew("Aida 42 🎉")).toBe("Aida 42 🎉");
  });
});

describe("stemPattern / containsStem", () => {
  it("matches the bare stem", () => {
    expect(containsStem("יש פגישה מחר", "פגישה")).toBe(true);
  });

  it.each(["לפגישה", "בפגישה", "הפגישה", "מהפגישה", "ולפגישה", "שבפגישה"])(
    "matches the stem behind clitic prefix(es): %s",
    (word) => {
      expect(containsStem(`הגענו ${word} אתמול`, "פגישה")).toBe(true);
    },
  );

  it("matches despite niqqud on the haystack", () => {
    expect(containsStem("הגענו לַפְּגִישָׁה", "פגישה")).toBe(true);
  });

  it("does not match an unrelated word", () => {
    expect(containsStem("יש ישיבה מחר", "פגישה")).toBe(false);
  });

  it("escapes regex metacharacters in the stem", () => {
    expect(() => stemPattern("a.b*c")).not.toThrow();
    expect(containsStem("literal a.b*c here", "a.b*c")).toBe(true);
    expect(containsStem("axbxxc", "a.b*c")).toBe(false);
  });
});

describe("containsPhrase", () => {
  it("matches a multi-word phrase across whitespace noise", () => {
    expect(containsPhrase("תכף תכף...  לא    מצאתי את זה בשיחה.", "לא מצאתי")).toBe(true);
  });

  it("does not match when the phrase is absent", () => {
    expect(containsPhrase("תכף תכף... רועי שאל אתמול", "לא מצאתי")).toBe(false);
  });

  it("is niqqud-insensitive", () => {
    expect(containsPhrase("לֹא מָצָאתִי את זה", "לא מצאתי")).toBe(true);
  });
});
