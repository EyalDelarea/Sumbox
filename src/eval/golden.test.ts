import { describe, expect, it } from "vitest";
import { absentItems, parseGolden, presentItems } from "./golden.js";

// Synthetic fixtures — no real group content, so this runs in CI.

const item = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "x-1",
    groupId: 1,
    question: "מה נאמר?",
    asOf: "2026-07-16T13:05:00Z",
    goldExternalIds: ["3ABC"],
    mustNotRefuse: true,
    slice: ["recency:<1h"],
    provenance: { added: "2026-07-16", reason: "test" },
    ...over,
  });

describe("parseGolden", () => {
  it("parses one item per line", () => {
    expect(parseGolden(`${item()}\n${item({ id: "x-2" })}`)).toHaveLength(2);
  });

  it("ignores blank lines and # comments", () => {
    expect(parseGolden(`# a comment\n\n${item()}\n\n`)).toHaveLength(1);
  });

  it("reports the line number on invalid JSON", () => {
    expect(() => parseGolden(`${item()}\nnot json`)).toThrow(/line 2/);
  });
});

describe("parseGolden — validation fails loudly", () => {
  // A malformed item that loaded as undefined would silently drop an assertion:
  // the harness would report green over fewer checks than it claims.
  it.each([
    ["missing id", { id: "" }, /`id`/],
    ["missing groupId", { groupId: "1" }, /`groupId`/],
    ["empty question", { question: "" }, /`question`/],
    ["missing asOf", { asOf: undefined }, /`asOf`/],
    ["unparseable asOf", { asOf: "not-a-date" }, /`asOf`/],
    ["goldExternalIds not an array", { goldExternalIds: "3ABC" }, /`goldExternalIds`/],
    ["mustNotRefuse not boolean", { mustNotRefuse: "yes" }, /`mustNotRefuse`/],
    ["empty slice", { slice: [] }, /`slice`/],
  ])("rejects %s", (_name, over, re) => {
    expect(() => parseGolden(item(over))).toThrow(re);
  });

  it("rejects mustNotRefuse with no gold ids — unprovable by construction", () => {
    expect(() => parseGolden(item({ mustNotRefuse: true, goldExternalIds: [] }))).toThrow(
      /unprovable/,
    );
  });

  it("allows a D_absent item (no gold ids, refusal is correct)", () => {
    expect(parseGolden(item({ mustNotRefuse: false, goldExternalIds: [] }))).toHaveLength(1);
  });
});

describe("present / absent slices", () => {
  const items = parseGolden(
    [item({ id: "p1" }), item({ id: "a1", mustNotRefuse: false, goldExternalIds: [] })].join("\n"),
  );

  it("splits on whether the answer is in the chat", () => {
    expect(presentItems(items).map((i) => i.id)).toEqual(["p1"]);
    expect(absentItems(items).map((i) => i.id)).toEqual(["a1"]);
  });
});
