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
