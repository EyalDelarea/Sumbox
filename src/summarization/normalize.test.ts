import { describe, expect, it } from "vitest";
import { normalizeSummaryOutput, summaryPreviewLine } from "./normalize.js";
import type { StructuredSummary } from "./summarizer.js";

describe("normalizeSummaryOutput", () => {
  it("passes a v2 structured summary through unchanged", () => {
    const structured: StructuredSummary = {
      version: 2,
      overview: "## תקציר\nתמצית\n## נושאים עיקריים\n- נושא ^1",
      tldr: "תמצית",
      topics: [{ text: "נושא", sourceMessageId: 42 }],
      decisions: [],
      openQuestions: [],
      actionItems: [],
    };
    const out = normalizeSummaryOutput(structured);
    expect(out.version).toBe(2);
    expect(out.tldr).toBe("תמצית");
    expect(out.topics).toEqual([{ text: "נושא", sourceMessageId: 42 }]);
    expect(out.overview).toBe(structured.overview);
  });

  it("sections a legacy prose row best-effort, as v1 with no jumps", () => {
    const legacy = { overview: "## תקציר\nשיחה.\n\n## נושאים עיקריים\n- נושא ראשון\n- נושא שני" };
    const out = normalizeSummaryOutput(legacy);
    expect(out.version).toBe(1);
    expect(out.overview).toBe(legacy.overview); // full prose retained
    expect(out.tldr).toBe("שיחה.");
    expect(out.topics).toEqual([{ text: "נושא ראשון" }, { text: "נושא שני" }]);
    expect(out.topics.every((b) => b.sourceMessageId === undefined)).toBe(true);
  });

  it("falls back to raw prose when a legacy row has no headings", () => {
    const legacy = { overview: "פסקה חופשית בלי כותרות." };
    const out = normalizeSummaryOutput(legacy);
    expect(out.version).toBe(1);
    expect(out.overview).toBe("פסקה חופשית בלי כותרות.");
    expect(out.tldr).toBe("פסקה חופשית בלי כותרות.");
    expect(out.topics).toEqual([]);
  });
});

describe("summaryPreviewLine", () => {
  it("returns an empty string for nullish or blank input", () => {
    expect(summaryPreviewLine(null)).toBe("");
    expect(summaryPreviewLine(undefined)).toBe("");
    expect(summaryPreviewLine("")).toBe("");
    expect(summaryPreviewLine("   \n  ")).toBe("");
  });

  it("returns a plain TL;DR line, trimmed", () => {
    expect(summaryPreviewLine("  התקבלה החלטה לארגן טיול  ")).toBe("התקבלה החלטה לארגן טיול");
  });

  it("skips markdown headings and returns the first content line", () => {
    expect(summaryPreviewLine("## תקציר\nשיחה על הטיול הבא.")).toBe("שיחה על הטיול הבא.");
  });

  it("returns an empty string when the text is only headings", () => {
    expect(summaryPreviewLine("## תקציר\n### נושאים")).toBe("");
  });

  it("strips a leading bullet marker and bold emphasis", () => {
    expect(summaryPreviewLine("- **ארוחת שישי:** אצל סבתא ב-19:00")).toBe(
      "ארוחת שישי: אצל סבתא ב-19:00",
    );
  });

  it("collapses internal whitespace runs", () => {
    expect(summaryPreviewLine("דני   סיים    את המסמך")).toBe("דני סיים את המסמך");
  });

  it("truncates long text on a word boundary with an ellipsis", () => {
    expect(summaryPreviewLine("alpha beta gamma delta", 12)).toBe("alpha beta…");
  });

  it("hard-truncates a single overlong word", () => {
    expect(summaryPreviewLine("supercalifragilistic", 8)).toBe("supercal…");
  });

  it("does not truncate text already within the limit", () => {
    expect(summaryPreviewLine("קצר", 140)).toBe("קצר");
  });
});
