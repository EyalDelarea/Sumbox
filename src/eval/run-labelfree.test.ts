import { describe, expect, it, vi } from "vitest";
import type { CorpusItem } from "./corpus.js";
import { runOnce, runRepeated } from "./run-labelfree.js";

const item = (q: string, id = "x"): CorpusItem => ({
  id,
  groupId: 70,
  question: q,
  asOf: new Date("2026-07-20T10:00:00Z"),
});

const deps = (answers: string[]) => {
  let i = 0;
  return {
    pool: {} as never,
    embedder: { embed: async () => [] } as never,
    model: {} as never,
    roster: async () => ["Royi"],
    answer: (async (_d: unknown, _i: unknown) => ({
      text: answers[i++] ?? "",
      citedIds: [],
    })) as never,
  };
};

describe("runOnce", () => {
  it("averages each metric across items", async () => {
    const { scores, answered } = await runOnce(
      deps(["תכף תכף... הכל טוב", "תכף תכף... לא מצאתי את זה בשיחה."]),
      [item("a", "1"), item("b", "2")],
    );
    expect(answered).toBe(2);
    expect(scores.persona_opener).toBe(1); // both opened correctly
    expect(scores.refused).toBe(0.5); // one of two refused
  });

  it("EXCLUDES a crashed item from the denominator rather than scoring it zero", async () => {
    // A crash is not a refusal. Counting it as one would quietly flatter or damn
    // a prompt change depending on which way the metric points.
    const d = {
      ...deps([]),
      answer: (async (_d: unknown, i: { question: string }) => {
        if (i.question === "boom") throw new Error("ollama died");
        return { text: "תכף תכף... הכל טוב", citedIds: [] };
      }) as never,
    };
    const { scores, answered } = await runOnce(d, [item("ok", "1"), item("boom", "2")]);
    expect(answered).toBe(1);
    expect(scores.refused).toBe(0); // 0/1, not 0.5
  });

  it("builds each group's roster once per run, not once per question", async () => {
    const roster = vi.fn(async () => ["Royi"]);
    await runOnce({ ...deps(["a", "b", "c"]), roster }, [
      item("1", "a"),
      item("2", "b"),
      item("3", "c"),
    ]);
    expect(roster).toHaveBeenCalledOnce();
  });

  it("returns zeros rather than NaN when every item fails", async () => {
    const d = {
      ...deps([]),
      answer: (async () => {
        throw new Error("all dead");
      }) as never,
    };
    const { scores, answered } = await runOnce(d, [item("x")]);
    expect(answered).toBe(0);
    expect(Number.isNaN(scores.refused)).toBe(false);
  });
});

describe("runRepeated", () => {
  it("produces one sample per run, so the spread is observable", async () => {
    // The whole point: N samples, not one number. A single sample has no spread
    // and compare() will refuse to draw a conclusion from it.
    const out = await runRepeated(
      deps(["תכף תכף... א", "תכף תכף... לא מצאתי את זה בשיחה.", "תכף תכף... ג"]),
      [item("q")],
      3,
    );
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.refused)).toEqual([0, 1, 0]);
  });
});
