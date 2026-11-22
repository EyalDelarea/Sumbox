import { describe, expect, it } from "vitest";
import { matchAskTrigger } from "../collector/ask-trigger.js";
import { DEFAULT_ROSEY_TAGS, loadRoseyConfig } from "./config.js";
import { makeTagMatcher, parseTagAliases } from "./tags.js";

const rosey = makeTagMatcher(parseTagAliases(DEFAULT_ROSEY_TAGS));

describe("parseTagAliases", () => {
  it("adds a missing @, trims, and de-duplicates", () => {
    expect(parseTagAliases(" Rosey, @רוזי ,@Rosey,,")).toEqual(["@Rosey", "@רוזי"]);
  });

  it("config falls back to the defaults when ROSEY_TAGS is blank", () => {
    expect(loadRoseyConfig({ ROSEY_TAGS: " , " }).tags).toEqual(["@Rosey", "@רוזי"]);
    expect(loadRoseyConfig({ ROSEY_TAGS: "@Rosie" }).tags).toEqual(["@Rosie"]);
  });
});

describe("tag matching", () => {
  it("matches either script, case-insensitively, anywhere in the text", () => {
    expect(rosey.isTagged("@Rosey לקנות חלב")).toBe(true);
    expect(rosey.isTagged("לקנות חלב @רוזי")).toBe(true);
    expect(rosey.isTagged("@ROSEY, milk")).toBe(true);
  });

  it("does not match a longer word that merely starts with the tag", () => {
    expect(rosey.isTagged("@Roseyy milk")).toBe(false);
    expect(rosey.isTagged("@רוזיה תקני חלב")).toBe(false);
    expect(rosey.isTagged("Rosey without the at sign")).toBe(false);
  });

  it("is disjoint from @Aida's trigger in both directions", () => {
    expect(rosey.isTagged("@Aida מה קורה?")).toBe(false);
    expect(rosey.isTagged("@אידה מה קורה?")).toBe(false);
    expect(matchAskTrigger("@Rosey לקנות חלב")).toBeNull();
    expect(matchAskTrigger("@רוזי לקנות חלב")).toBeNull();
  });

  it("honours configured aliases only", () => {
    const custom = makeTagMatcher(["@Rosie"]);
    expect(custom.isTagged("@Rosie milk")).toBe(true);
    expect(custom.isTagged("@Rosey milk")).toBe(false);
  });
});

describe("command parsing", () => {
  it("one line is one task, even with commas", () => {
    expect(rosey.parse("@Rosey לקנות חלב, ביצים ולחם")).toEqual({
      kind: "add",
      items: ["לקנות חלב, ביצים ולחם"],
      itemKind: "task",
    });
  });

  it("each line of a list is its own task, with bullets stripped", () => {
    expect(rosey.parse("@רוזי\n- חלב\n* ביצים\n2) לחם\n✅ קפה\n\n")).toEqual({
      kind: "add",
      items: ["חלב", "ביצים", "לחם", "קפה"],
      itemKind: "task",
    });
  });

  it("a leading done-word is a completion, with the rest as the query", () => {
    expect(rosey.parse("@Rosey done: milk")).toEqual({ kind: "done", query: "milk" });
    expect(rosey.parse("@רוזי בוצע לקנות חלב")).toEqual({ kind: "done", query: "לקנות חלב" });
    expect(rosey.parse("@רוזי בוצע")).toEqual({ kind: "done", query: "" });
  });

  it("a done-word that is only the start of another word is an ordinary item", () => {
    expect(rosey.parse("@Rosey doneness check")).toEqual({
      kind: "add",
      items: ["doneness check"],
      itemKind: "task",
    });
  });

  it("a grocery word with a colon makes the items grocery, on the same line or below", () => {
    expect(rosey.parse("@Rosey קניות: חלב")).toEqual({
      kind: "add",
      items: ["חלב"],
      itemKind: "grocery",
    });
    expect(rosey.parse("@רוזי קניות:\n- חלב\n- לחם")).toEqual({
      kind: "add",
      items: ["חלב", "לחם"],
      itemKind: "grocery",
    });
    expect(rosey.parse("@Rosey Shopping: milk")).toEqual({
      kind: "add",
      items: ["milk"],
      itemKind: "grocery",
    });
  });

  it("reads the prefix through WhatsApp's invisible direction marks and a full-width colon", () => {
    expect(rosey.parse("@Rosey ‏קניות‏: חלב")).toMatchObject({
      items: ["חלב"],
      itemKind: "grocery",
    });
    expect(rosey.parse("@Rosey קניות：חלב")).toMatchObject({ items: ["חלב"], itemKind: "grocery" });
  });

  it("a grocery word alone on the first line heads a grocery list", () => {
    expect(rosey.parse("@רוזי קניות\nחלב\nלחם")).toEqual({
      kind: "add",
      items: ["חלב", "לחם"],
      itemKind: "grocery",
    });
  });

  it("a grocery word that is just the start of a sentence is an ordinary task", () => {
    expect(rosey.parse("@Rosey קניות לשבת")).toEqual({
      kind: "add",
      items: ["קניות לשבת"],
      itemKind: "task",
    });
    expect(rosey.parse("@Rosey קניותי: x")).toMatchObject({ itemKind: "task" });
  });

  it("a grocery prefix with no item is nothing to do", () => {
    expect(rosey.parse("@Rosey קניות:")).toBeNull();
    expect(rosey.parse("@Rosey קניות")).toBeNull();
  });

  it("a bare tag, or an untagged message, is nothing to do", () => {
    expect(rosey.parse("@Rosey")).toBeNull();
    expect(rosey.parse("לקנות חלב")).toBeNull();
  });

  it("caps an over-long line", () => {
    const parsed = rosey.parse(`@Rosey ${"א".repeat(500)}`);
    expect(parsed?.kind === "add" && parsed.items[0]?.length).toBe(200);
  });
});

describe("list request", () => {
  it("recognizes the fixed phrasings, Hebrew and English, with the tag anywhere", () => {
    for (const text of [
      "@Rosey what's the task list?",
      "@Rosey what’s the list",
      "@rosey list",
      "@Rosey tasks?",
      "@רוזי מה המשימות?",
      "@רוזי רשימה",
      "@רוזי מה יש?",
      "@רוזי מה יש ברשימה",
      "@רוזי מה פתוח?!",
      "מה המשימות @רוזי",
      "@רוזי ‏מה המשימות‏?",
    ]) {
      expect(rosey.isListRequest(text), text).toBe(true);
    }
  });

  it("is a fixed pattern: anything else is not a list request", () => {
    for (const text of [
      "מה המשימות?", // untagged
      "@Rosey list the groceries for Friday",
      "@Rosey לקנות רשימה של מתנות",
      "@רוזי מה יש לאכול",
      "@רוזי רשימה של קניות לשבת",
      "@Rosey done list",
      "@Rosey",
      "",
    ]) {
      expect(rosey.isListRequest(text), text).toBe(false);
    }
  });

  it("tolerates punctuation, possessives, את / בבקשה and the English variants", () => {
    for (const text of [
      "@Rosey מה המשימות שלנו?",
      "@רוזי מה המשימות שלי?!",
      "@רוזי מה הרשימה שלנו.",
      "@רוזי את הרשימה בבקשה",
      "@רוזי בבקשה, מה המשימות שלנו?",
      "@רוזי תראי לי את המשימות",
      "@רוזי תראי את הרשימה שלנו בבקשה!",
      "@Rosey what's the list?",
      "@Rosey whats our list",
      "@Rosey show tasks",
      "@Rosey show me the tasks please",
      "@Rosey show my list!",
      "@Rosey, what are our tasks?",
    ]) {
      expect(rosey.isListRequest(text), text).toBe(true);
      expect(rosey.parse(text), text).toBeNull();
    }
  });

  it("a question that names the tasks or the list never becomes a task", () => {
    for (const text of [
      "@Rosey מה עם המשימות של השבוע?",
      "@רוזי איזה משימות נשארו?",
      "@רוזי מה נשאר ברשימה להיום",
      "@Rosey which tasks are still open?",
      "@Rosey anything left on the list?",
    ]) {
      expect(rosey.parse(text), text).toBeNull();
    }
  });

  it("an ordinary task that mentions a list stays a task", () => {
    for (const [text, item] of [
      ["@Rosey לקנות רשימה של מתנות לחג", "לקנות רשימה של מתנות לחג"],
      ["@Rosey להכין רשימת מוזמנים", "להכין רשימת מוזמנים"],
      ["@רוזי לסדר את המשימות של הבית בלוח", "לסדר את המשימות של הבית בלוח"],
      ["@Rosey print the shopping list", "print the shopping list"],
      ["@רוזי מה יש לאכול", "מה יש לאכול"],
      ["@Rosey do the garden tasks", "do the garden tasks"],
      ["@Rosey is the list printed", "is the list printed"],
    ] as const) {
      expect(rosey.isListRequest(text), text).toBe(false);
      expect(rosey.parse(text), text).toMatchObject({ kind: "add", items: [item] });
    }
  });

  it("a list request is never parsed as an item to add, so no replay can store it", () => {
    expect(rosey.parse("@רוזי מה המשימות?")).toBeNull();
    expect(rosey.parse("@Rosey what's the task list?")).toBeNull();
    // A near miss is still an ordinary add.
    expect(rosey.parse("@רוזי מה יש לאכול")).toMatchObject({ kind: "add" });
  });
});
