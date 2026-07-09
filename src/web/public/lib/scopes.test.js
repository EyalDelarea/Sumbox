import { describe, expect, it } from "vitest";
import { activeCount, filterScopes, groupByCategory, partitionRemoved } from "./scopes.js";

const s = (group, over = {}) => ({
  group,
  source: "import",
  messageCount: 1,
  lastMessageAt: null,
  included: true,
  categoryId: null,
  removed: false,
  ...over,
});

describe("filterScopes", () => {
  const scopes = [
    s("עבודה צוות"),
    s("משפחה", { included: false }),
    s("לקוח חשוב", { categoryId: 3 }),
    s("ישן", { removed: true }),
  ];

  it("drops removed chats from every segment", () => {
    const names = filterScopes(scopes, { query: "", segment: "all" }).map((x) => x.group);
    expect(names).not.toContain("ישן");
    expect(names).toHaveLength(3);
  });

  it("filters by case-insensitive name query", () => {
    expect(filterScopes(scopes, { query: "לקוח", segment: "all" }).map((x) => x.group)).toEqual([
      "לקוח חשוב",
    ]);
  });

  it("segments included vs excluded", () => {
    expect(filterScopes(scopes, { query: "", segment: "included" }).map((x) => x.group)).toEqual([
      "עבודה צוות",
      "לקוח חשוב",
    ]);
    expect(filterScopes(scopes, { query: "", segment: "excluded" }).map((x) => x.group)).toEqual([
      "משפחה",
    ]);
  });
});

describe("partitionRemoved", () => {
  it("splits active vs removed", () => {
    const { active, removed } = partitionRemoved([s("a"), s("b", { removed: true })]);
    expect(active.map((x) => x.group)).toEqual(["a"]);
    expect(removed.map((x) => x.group)).toEqual(["b"]);
  });
});

describe("groupByCategory", () => {
  const cats = [
    { id: 1, name: "עבודה", isSystem: true, sortOrder: 0 },
    { id: 2, name: "אישי", isSystem: true, sortOrder: 1 },
  ];

  it("orders by sortOrder, keeps empty categories, and buckets uncategorized last", () => {
    const scopes = [s("w1", { categoryId: 1 }), s("u1")];
    const sections = groupByCategory(scopes, cats);
    expect(sections.map((sec) => sec.category?.name ?? "ללא קטגוריה")).toEqual([
      "עבודה",
      "אישי", // empty but preserved
      "ללא קטגוריה",
    ]);
    expect(sections[0].scopes.map((x) => x.group)).toEqual(["w1"]);
    expect(sections[1].scopes).toEqual([]);
    expect(sections[2].scopes.map((x) => x.group)).toEqual(["u1"]);
  });

  it("omits the uncategorized bucket when everything is categorized", () => {
    const sections = groupByCategory([s("w1", { categoryId: 1 })], cats);
    expect(sections.some((sec) => sec.category === null)).toBe(false);
  });
});

describe("activeCount", () => {
  it("counts included non-removed over non-removed total", () => {
    expect(activeCount([s("a"), s("b", { included: false }), s("c", { removed: true })])).toEqual({
      active: 1,
      total: 2,
    });
  });
});
