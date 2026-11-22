import { describe, expect, it } from "vitest";
import { lastJsonValue, salvageItemObjects, titleKey } from "./text.js";

describe("titleKey", () => {
  it("ignores case, punctuation, emoji, niqqud, and spacing", () => {
    expect(titleKey("  לִקְנוֹת   חלב! 🥛 ")).toBe("לקנות חלב");
    expect(titleKey("Call the PLUMBER.")).toBe(titleKey("call the plumber"));
  });

  it("reads a maqaf as a space, like a hyphen", () => {
    expect(titleKey("בית־ספר")).toBe("בית ספר");
    expect(titleKey("בית־ספר")).toBe(titleKey("בית-ספר"));
  });

  it("keeps different items different", () => {
    expect(titleKey("לקנות חלב")).not.toBe(titleKey("לקנות ביצים"));
  });
});

describe("lastJsonValue", () => {
  it("parses a bare object or array", () => {
    expect(lastJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(lastJsonValue("[1,2]")).toEqual([1, 2]);
  });

  it("takes the LAST complete value when the model revises itself in prose", () => {
    const reply = 'Here: {"items":[1]}\nActually, correction: {"items":[1,2]}';
    expect(lastJsonValue(reply)).toEqual({ items: [1, 2] });
  });

  it("is not fooled by brackets inside strings", () => {
    expect(lastJsonValue('{"text":"a } b ] c"}')).toEqual({ text: "a } b ] c" });
    expect(lastJsonValue('{"text":"quote \\" and }"}')).toEqual({ text: 'quote " and }' });
  });

  it("skips a trailing bracketed non-JSON fragment and finds the real value", () => {
    expect(lastJsonValue('{"same_as":2} [see item 2]')).toEqual({ same_as: 2 });
  });

  it("returns null when there is no JSON at all", () => {
    expect(lastJsonValue("no json here")).toBeNull();
    expect(lastJsonValue('{"unterminated": ')).toBeNull();
  });
});

describe("salvageItemObjects", () => {
  it("keeps every well-formed object of the items array and counts the broken ones", () => {
    const reply =
      '```json\n{"items": [{"m": 1, "text": "a"}, {"m": 10625cut57, "text": "b"}, {"m": 2, "text": "}{"}]}\n```';
    expect(salvageItemObjects(reply)).toEqual({
      objects: [
        { m: 1, text: "a" },
        { m: 2, text: "}{" },
      ],
      malformed: 1,
    });
  });

  it("an items array that never closes is a truncated reply: nothing is salvaged", () => {
    expect(salvageItemObjects('{"items": [{"m": 1, "text": "a"}, {"m": 2, "te')).toBeNull();
    expect(
      salvageItemObjects('{"items": [{"m": 1, "text": "a"}, {"m": 2, "text": "b"}'),
    ).toBeNull();
  });

  it("no items array at all is nothing to salvage", () => {
    expect(salvageItemObjects("no tasks here")).toBeNull();
    expect(salvageItemObjects('{"tasks": [{"m": 1}]}')).toBeNull();
  });
});
