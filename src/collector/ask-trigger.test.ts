import { describe, expect, it } from "vitest";
import { matchAskTrigger } from "./ask-trigger.js";

describe("matchAskTrigger", () => {
  it("matches @אידה (Hebrew) and extracts the question", () => {
    expect(matchAskTrigger("@אידה מתי נפגשים היום?")).toEqual({ question: "מתי נפגשים היום?" });
  });

  it("matches @Aida (Latin, any case) and extracts the question", () => {
    expect(matchAskTrigger("hey @Aida did we decide?")).toEqual({ question: "hey did we decide?" });
    expect(matchAskTrigger("@AIDA what's up")).toEqual({ question: "what's up" });
  });

  it("matches the tag mid-sentence, not only at the start", () => {
    expect(matchAskTrigger("רועי, @אידה תזכירי מה סוכם")).toEqual({
      question: "רועי, תזכירי מה סוכם",
    });
  });

  it("tolerates punctuation right after the tag", () => {
    expect(matchAskTrigger("@Aida, מה קורה?")).toEqual({ question: ", מה קורה?" });
  });

  it("returns null when there is no tag", () => {
    expect(matchAskTrigger("סתם הודעה רגילה בלי תיוג")).toBeNull();
    expect(matchAskTrigger("email me at a@aida (not a mention)")).not.toBeNull(); // '@aida' present
  });

  it("does NOT trigger on a longer word that merely starts with the tag", () => {
    expect(matchAskTrigger("@אידהלה שלום")).toBeNull(); // @אידה + לה, no word boundary
    expect(matchAskTrigger("@Aidan hello")).toBeNull();
  });

  it("a bare @Aida with no other words is a match with an empty question", () => {
    expect(matchAskTrigger("@אידה")).toEqual({ question: "" });
  });

  it("strips multiple tags", () => {
    expect(matchAskTrigger("@Aida @אידה מי בא?")).toEqual({ question: "מי בא?" });
  });

  it("is empty-safe", () => {
    expect(matchAskTrigger("")).toBeNull();
  });
});
