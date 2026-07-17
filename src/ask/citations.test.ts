import { describe, expect, it } from "vitest";
import { extractCitations } from "./citations.js";
import { NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC } from "./prompt.js";

const valid = new Set([101, 102, 103]);

describe("extractCitations", () => {
  it("returns the cited ids and strips the tags from what she says", () => {
    const { text, citedIds } = extractCitations("תכף תכף... אמרתם 21:00 בכיכר [msg:101]", valid);
    expect(citedIds).toEqual([101]);
    expect(text).toBe("תכף תכף... אמרתם 21:00 בכיכר");
  });

  it("drops an id she was never shown", () => {
    // The anti-hallucination gate. The spike saw zero invented ids, but "none so
    // far" is not a guarantee — an id we cannot resolve must never reach send.
    const { text, citedIds } = extractCitations("אמרתם 21:00 [msg:999]", valid);
    expect(citedIds).toEqual([]);
    expect(text).toBe("אמרתם 21:00"); // the tag still goes, valid or not
  });

  it("keeps the valid ids when she cites a mix", () => {
    const { citedIds } = extractCitations("א [msg:101] ב [msg:999] ג [msg:102]", valid);
    expect(citedIds).toEqual([101, 102]);
  });

  it("dedupes repeats but keeps first-seen order", () => {
    // The first cite decides which message gets quoted, so order is not cosmetic.
    const { citedIds } = extractCitations("א [msg:102] ב [msg:101] ג [msg:102]", valid);
    expect(citedIds).toEqual([102, 101]);
  });

  it("leaves clean Hebrew behind — no double spaces or orphaned punctuation", () => {
    const { text } = extractCitations("תכף תכף... רועי אמר [msg:101] שזה בוטל [msg:102].", valid);
    expect(text).toBe("תכף תכף... רועי אמר שזה בוטל.");
    expect(text).not.toMatch(/ {2}/);
    expect(text).not.toMatch(/ \./);
  });

  it("handles a tag on its own line", () => {
    const { text } = extractCitations("תכף תכף... כן\n[msg:101]", valid);
    expect(text).toBe("תכף תכף... כן");
  });

  describe("plural and malformed tags — the prompt asks for 'id(s)'", () => {
    // CITE_RULE says "cite the message id(s)… in the form [msg:12345]": plural
    // instruction, singular example. A two-source claim reasonably comes back as
    // [msg:101, 102]. Matching only the canonical form would both lose the
    // citation AND ship internal ids to the group.
    it.each([
      ["שניהם [msg:101, 102]", [101, 102]],
      ["שניהם [msg:101, msg:102]", [101, 102]],
      ["רווח [msg: 101]", [101]],
      ["צמוד [msg:101][msg:102]", [101, 102]],
    ])("%s", (raw, expected) => {
      const { text, citedIds } = extractCitations(raw, valid);
      expect(citedIds).toEqual(expected);
      expect(text).not.toMatch(/\[\s*msg/i);
    });

    it.each([
      "טווח [msg:101-102]",
      "מוזר [msg:abc]",
      "ריק [msg:]",
      "מלל [msg: הודעה ראשונה]",
    ])("strips a tag it cannot parse rather than leaking it: %s", (raw) => {
      // Losing a citation is cheap; showing the group our internal ids is not.
      const { text } = extractCitations(raw, valid);
      expect(text).not.toMatch(/\[\s*msg/i);
    });
  });

  it("never lets a tag-shaped string reach the group", () => {
    // The fence against future format drift: whatever she emits, nothing that
    // looks like a tag survives into what she says.
    const raws = [
      "א [msg:101]",
      "ב [msg:999]",
      "ג [msg:101, 102]",
      "ד [MSG:101]",
      "ה [msg:101-103]",
    ];
    for (const raw of raws) {
      expect(extractCitations(raw, valid).text).not.toMatch(/\[\s*msg/i);
    }
  });

  it("reports no citation when she emits none (~8% of replies)", () => {
    const { text, citedIds } = extractCitations("תכף תכף... אין לי מושג", valid);
    expect(citedIds).toEqual([]);
    expect(text).toBe("תכף תכף... אין לי מושג");
  });

  it.each([NOT_IN_CHAT, NOT_INDEXED, OFF_TOPIC])("never cites on a refusal: %s", (refusal) => {
    // A denial pinned to a message is a contradiction — it would quote the very
    // message it claims not to have found. A stray tag here is noise, not a source.
    const { citedIds } = extractCitations(`תכף תכף... ${refusal} [msg:101]`, valid);
    expect(citedIds).toEqual([]);
  });

  it("still strips the tags from a refusal", () => {
    const { text } = extractCitations(`תכף תכף... ${NOT_IN_CHAT} [msg:101]`, valid);
    expect(text).toBe(`תכף תכף... ${NOT_IN_CHAT}`);
  });
});
