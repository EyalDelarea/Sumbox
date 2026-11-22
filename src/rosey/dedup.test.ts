import { describe, expect, it } from "vitest";
import { decideDuplicate, parseDedupAnswer } from "./dedup.js";

const live = [
  { id: 101, title: "לקנות חלב", titleKey: "לקנות חלב" },
  { id: 102, title: "להתקשר לאינסטלטור", titleKey: "להתקשר לאינסטלטור" },
];
const never = () => Promise.reject(new Error("model must not be called"));
const answer = (s: string) => () => Promise.resolve(s);

describe("decideDuplicate", () => {
  it("matches an exact key without asking the model", async () => {
    expect(
      await decideDuplicate({ title: "לקנות חלב!", titleKey: "לקנות חלב" }, live, never),
    ).toEqual({ kind: "exact", taskId: 101 });
  });

  it("is new without asking when there is nothing live to compare against", async () => {
    expect(await decideDuplicate({ title: "x", titleKey: "x" }, [], never)).toEqual({
      kind: "new",
    });
  });

  it("maps the model's 1-based answer to the task id", async () => {
    const d = await decideDuplicate(
      { title: "לזמן אינסטלטור", titleKey: "לזמן אינסטלטור" },
      live,
      answer('{"same_as": 2}'),
    );
    expect(d).toEqual({ kind: "model", taskId: 102 });
  });

  it("keeps the candidate as new when the answer is out of range or unparseable", async () => {
    const c = { title: "y", titleKey: "y" };
    expect(await decideDuplicate(c, live, answer('{"same_as": 3}'))).toEqual({
      kind: "new_unparsed",
    });
    expect(await decideDuplicate(c, live, answer("maybe the first one?"))).toEqual({
      kind: "new_unparsed",
    });
  });

  it("propagates a transport failure instead of guessing 'new'", async () => {
    await expect(
      decideDuplicate({ title: "y", titleKey: "y" }, live, () =>
        Promise.reject(new Error("ECONNREFUSED")),
      ),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("parseDedupAnswer", () => {
  it("accepts null as not-a-duplicate and rejects non-integers", () => {
    expect(parseDedupAnswer('{"same_as": null}', live)).toEqual({ kind: "new" });
    expect(parseDedupAnswer('{"same_as": 1.5}', live)).toBeNull();
    expect(parseDedupAnswer('{"same_as": 0}', live)).toBeNull();
    expect(parseDedupAnswer('{"other": 1}', live)).toBeNull();
  });
});
