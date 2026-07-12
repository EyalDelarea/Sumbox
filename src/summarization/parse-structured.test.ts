import { describe, expect, it } from "vitest";
import {
  parseStructuredSummary,
  splitTrailingMarkers,
  stripAllMarkers,
} from "./parse-structured.js";

// index → messages.id, as built from the selection passed to the model.
const idx = new Map<number, number>([
  [1, 1001],
  [2, 1002],
  [3, 1003],
]);

describe("parseStructuredSummary", () => {
  it("parses the four Hebrew sections, bullets, and ^N source markers", () => {
    const raw = [
      "## תקציר",
      "הצוות סיכם את שבוע העבודה והחליט על דדליין.",
      "",
      "## נושאים עיקריים",
      "- דנה העלתה את נושא התקציב ^1",
      "- יוסי דיווח על התקדמות בפיתוח ^2",
      "",
      "## החלטות ומשימות",
      "- הוחלט לשחרר ביום חמישי ^3",
      "",
      "## שאלות פתוחות",
      "- מי אחראי על הבדיקות?",
    ].join("\n");

    const out = parseStructuredSummary(raw, idx);

    expect(out.version).toBe(2);
    // Full markdown retained for back-compat + copy, but WITHOUT the citation
    // markers — overview is what the CLI/WhatsApp/copy actually render, and a raw
    // `^N` there is junk to the reader. The ids live on the bullets instead.
    expect(out.overview).not.toContain("^");
    expect(out.overview).toContain("## תקציר");
    expect(out.overview).toContain("דנה העלתה את נושא התקציב");
    expect(out.tldr).toBe("הצוות סיכם את שבוע העבודה והחליט על דדליין.");
    expect(out.topics).toEqual([
      { text: "דנה העלתה את נושא התקציב", sourceMessageId: 1001 },
      { text: "יוסי דיווח על התקדמות בפיתוח", sourceMessageId: 1002 },
    ]);
    expect(out.decisions).toEqual([{ text: "הוחלט לשחרר ביום חמישי", sourceMessageId: 1003 }]);
    expect(out.openQuestions).toEqual([{ text: "מי אחראי על הבדיקות?" }]);
  });

  it("handles a sparse תקציר-only summary", () => {
    const raw = "## תקציר\nשיחה קצרה ללא החלטות.";
    const out = parseStructuredSummary(raw, idx);
    expect(out.overview).toBe(raw);
    expect(out.tldr).toBe("שיחה קצרה ללא החלטות.");
    expect(out.topics).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.openQuestions).toEqual([]);
  });

  it("drops an out-of-range marker but keeps the bullet text", () => {
    const raw = "## נושאים עיקריים\n- בולט עם מרקר לא תקין ^99";
    const out = parseStructuredSummary(raw, idx);
    expect(out.topics).toEqual([{ text: "בולט עם מרקר לא תקין" }]);
    expect(out.topics[0]?.sourceMessageId).toBeUndefined();
  });

  // The prompt asks for a bare `^N`, but the local model is inconsistent and
  // emits the visible `[#N]` line-label form (and comma-separated lists), often
  // with a trailing full stop. The parser must tolerate every shape it produces,
  // else the To-dos/Meetings tabs stay empty (no sourceMessageId → no extraction).
  it("resolves the model's real-world ^[#N] citation form (and strips it)", () => {
    const raw = "## החלטות ומשימות\n- אינבל תביא זירו לישיבה ^[#3].";
    const out = parseStructuredSummary(raw, idx);
    expect(out.decisions).toEqual([{ text: "אינבל תביא זירו לישיבה", sourceMessageId: 1003 }]);
  });

  it("resolves a bracketed multi-source ^[#N, #M] marker to its FIRST index", () => {
    const raw = "## החלטות ומשימות\n- בר הציע לשבת מחר ^[#1, #2].";
    const out = parseStructuredSummary(raw, idx);
    expect(out.decisions).toEqual([{ text: "בר הציע לשבת מחר", sourceMessageId: 1001 }]);
  });

  it("resolves repeated bare caret markers ^N, ^M, ^K to the first index", () => {
    const raw = "## החלטות ומשימות\n- נועה תבצע הדמיות בלילה ^2, ^3, ^1.";
    const out = parseStructuredSummary(raw, idx);
    expect(out.decisions).toEqual([{ text: "נועה תבצע הדמיות בלילה", sourceMessageId: 1002 }]);
  });

  it("resolves a caret-less [#N] / [N, M] bracket marker", () => {
    const raw = "## נושאים עיקריים\n- בר תצא מאוחר [1, 3].";
    const out = parseStructuredSummary(raw, idx);
    expect(out.topics).toEqual([{ text: "בר תצא מאוחר", sourceMessageId: 1001 }]);
  });

  it("leaves a bare trailing number (no caret/bracket) as content", () => {
    const raw = "## נושאים עיקריים\n- הפגישה נקבעה לשעה 14";
    const out = parseStructuredSummary(raw, idx);
    expect(out.topics).toEqual([{ text: "הפגישה נקבעה לשעה 14" }]);
  });

  it("treats bullets with no marker as plain (no sourceMessageId)", () => {
    const raw = "## החלטות ומשימות\n- החלטה ללא מקור\n* בולט עם כוכבית";
    const out = parseStructuredSummary(raw, idx);
    expect(out.decisions).toEqual([{ text: "החלטה ללא מקור" }, { text: "בולט עם כוכבית" }]);
  });

  it("never throws when the model ignored the format — tldr = raw", () => {
    const raw = "סתם טקסט חופשי ללא כותרות בכלל.";
    const out = parseStructuredSummary(raw, idx);
    expect(out.version).toBe(2);
    expect(out.overview).toBe(raw);
    expect(out.tldr).toBe("סתם טקסט חופשי ללא כותרות בכלל.");
    expect(out.topics).toEqual([]);
  });

  it("ignores unknown sections like ## לפי משתתף", () => {
    const raw = "## תקציר\nתמצית.\n\n## לפי משתתף\n- דנה: משהו";
    const out = parseStructuredSummary(raw, idx);
    expect(out.tldr).toBe("תמצית.");
    expect(out.topics).toEqual([]);
    expect(out.decisions).toEqual([]);
  });

  it("reserves actionItems as empty in S3 (populated by a later slice)", () => {
    const raw = "## החלטות ומשימות\n- הוחלט משהו ^1";
    const out = parseStructuredSummary(raw, idx);
    expect(out.actionItems).toEqual([]);
  });
});

describe("splitTrailingMarkers", () => {
  it.each([
    ["א.כ. [3]", "א.כ.", [3]],
    ["א.כ. [#3]", "א.כ.", [3]], // the historical 'empty To-dos' form must resolve
    ["מאיה ^3", "מאיה", [3]],
    ["מאיה ^[#3]", "מאיה", [3]],
    ["נוכח ב [#3, #4]", "נוכח ב", [3, 4]],
    ["סיכום ^4, ^8, ^14", "סיכום", [4, 8, 14]],
  ])("resolves %j -> text %j, indices %j", (input, text, indices) => {
    expect(splitTrailingMarkers(input)).toEqual({ text, indices });
  });

  it("treats a bare trailing number as content, not a marker", () => {
    expect(splitTrailingMarkers("לשעה 14")).toEqual({ text: "לשעה 14", indices: [] });
  });
});

// ── bare, number-less carets ─────────────────────────────────────────────────
//
// The prompt asks the model to end a bullet with `^N` citing a source line, and
// to OMIT the marker when no single line applies. gemma4:26b often does neither:
// it emits a bare `^` with no number. Every strip regex requires \d+ after the
// caret, so those carets survived into the rendered Hebrew — observed live in
// real summaries ("...וצורך בחומרים ^.") including inside ## תקציר, where the
// prompt forbids markers outright.

describe("bare caret markers (no index)", () => {
  it("strips a trailing bare caret", () => {
    const { text, indices } = stripAllMarkers("המטרה היא לחסוך זמן ^");
    expect(text).toBe("המטרה היא לחסוך זמן");
    expect(indices).toEqual([]);
  });

  it("strips a bare caret that sits mid-sentence before punctuation", () => {
    // The exact shape seen in production: caret, then the sentence continues.
    const { text } = stripAllMarkers("והמערכת מחשבת אוטומטית זוויות ^. המטרה היא לחסוך זמן ^.");
    expect(text).toBe("והמערכת מחשבת אוטומטית זוויות. המטרה היא לחסוך זמן.");
  });

  it("still captures a real ^N and still strips it", () => {
    const { text, indices } = stripAllMarkers("רועי הציע להשתמש במודל Claude ^7");
    expect(text).toBe("רועי הציע להשתמש במודל Claude");
    expect(indices).toEqual([7]);
  });

  it("handles a bare caret and a numbered one in the same bullet", () => {
    const { text, indices } = stripAllMarkers("אלכס הציג רעיון ^. רועי הגיב ^12");
    expect(text).toBe("אלכס הציג רעיון. רועי הגיב");
    expect(indices).toEqual([12]);
  });

  it("does not touch a caret that is followed by an index — that is the marker form", () => {
    // NOTE: a caret followed by digits is INDISTINGUISHABLE from a citation, so
    // "2^3" is (pre-existing behavior) read as a marker and stripped. Out of scope
    // here; this test only pins that bare carets are handled without changing that.
    const { indices } = stripAllMarkers("סעיף ^3");
    expect(indices).toEqual([3]);
  });
});

describe("overview / tldr are marker-free (what the reader actually sees)", () => {
  // overview is rendered by the CLI, the WhatsApp reply, the legacy history card
  // and "העתק סיכום". Keeping it byte-verbatim meant every stray caret reached
  // the reader — this is the junk observed in real summaries.
  const raw = [
    "## תקציר",
    "השיחה עוסקת בפיתוח כלי AI ^. המשתתפים דנו במחירים ^.",
    "",
    "## נושאים עיקריים",
    "* **פיתוח כלי AI:** אלכס הציג רעיון ^[#12].",
    "* **ניהול רכש:** הקבוצה דנה בהזמנת בד ^7",
  ].join("\n");

  it("strips markers out of overview but keeps the markdown structure", () => {
    const out = parseStructuredSummary(raw, new Map([[12, 5000]]));
    expect(out.overview).not.toContain("^");
    expect(out.overview).not.toContain("[#12]");
    // structure survives — headings and bullets still render
    expect(out.overview).toContain("## תקציר");
    expect(out.overview).toContain("## נושאים עיקריים");
    expect(out.overview).toContain("* **פיתוח כלי AI:**");
    expect(out.overview).toContain("אלכס הציג רעיון.");
  });

  it("strips a mid-sentence caret from tldr, which stripMarker (trailing-only) missed", () => {
    const out = parseStructuredSummary(raw, new Map());
    expect(out.tldr).not.toContain("^");
    expect(out.tldr).toBe("השיחה עוסקת בפיתוח כלי AI. המשתתפים דנו במחירים.");
  });

  it("still resolves the source id even though the marker is gone from the text", () => {
    const out = parseStructuredSummary(raw, new Map([[12, 5000]]));
    expect(out.topics[0]?.sourceMessageId).toBe(5000); // nothing lost
    expect(out.topics[0]?.text).not.toContain("^");
  });
});
