import { describe, expect, it } from "vitest";
import type { GoldenItem } from "./golden.js";
import { runItem, runSuiteE } from "./run-e.js";

// The answer fn and pool are injected, so this needs no DB and no model.

const item = (over: Partial<GoldenItem> = {}): GoldenItem => ({
  id: "p1",
  groupId: 70,
  question: "מה נאמר?",
  asOf: "2026-07-16T13:05:00Z",
  goldExternalIds: ["3ABC"],
  mustNotRefuse: true,
  expectedToolCalls: ["search_chat"],
  slice: ["recency:<5m"],
  provenance: { added: "2026-07-16", reason: "unit" },
  ...over,
});

/** Pool that resolves the given external_ids to sequential local ids. */
const fakePool = (rows: { id: string; external_id: string }[]) =>
  ({ query: async () => ({ rows }) }) as never;

const deps = (over: Record<string, unknown> = {}) => ({
  pool: fakePool([{ id: "11", external_id: "3ABC" }]),
  embedder: { embed: async () => [0.1] },
  model: {} as never,
  answer: (async () => "תכף תכף... רועי אמר משהו.") as never,
  ...over,
});

describe("runItem", () => {
  it("does NOT count the pre-seed as a tool call she chose to make", async () => {
    // The first onRetrieved is the unconditional pre-seed. Counting it made
    // tool_called read 1.00 by construction — a metric measuring our own code.
    const answer = (async (d: { onRetrieved?: (ids: number[]) => void }) => {
      d.onRetrieved?.([1, 2]); // pre-seed
      return "תכף תכף... תשובה.";
    }) as never;
    const out = await runItem(deps({ answer }) as never, item());
    expect(out.toolCalls).toBe(0);
    // ...but its ids ARE context, so they still count as retrieved.
    expect(out.retrievedIds).toEqual([1, 2]);
  });

  it("counts only the searches beyond the pre-seed", async () => {
    const answer = (async (d: { onRetrieved?: (ids: number[]) => void }) => {
      d.onRetrieved?.([1, 2]); // pre-seed
      d.onRetrieved?.([2, 3]); // a real tool call
      return "תכף תכף... תשובה.";
    }) as never;
    const out = await runItem(deps({ answer }) as never, item());
    expect(out.toolCalls).toBe(1);
    expect(out.retrievedIds).toEqual([1, 2, 3]);
    expect(out.goldIds).toEqual([11]);
  });

  it("reports nothing retrieved when the loop never surfaced anything", async () => {
    const out = await runItem(deps() as never, item());
    expect(out.toolCalls).toBe(0);
    expect(out.retrievedIds).toEqual([]);
  });

  it("resolves no gold for a D_absent item without querying", async () => {
    const out = await runItem(
      deps({
        pool: {
          query: async () => {
            throw new Error("must not query");
          },
        },
      }) as never,
      item({ goldExternalIds: [] }),
    );
    expect(out.goldIds).toEqual([]);
  });

  it("throws a ROTTED-ITEM error when a gold external_id is gone", async () => {
    // Must not be read as a retrieval regression.
    await expect(runItem(deps({ pool: fakePool([]) }) as never, item())).rejects.toThrow(/rotted/);
  });
});

describe("runSuiteE", () => {
  it("evaluates every item and aggregates", async () => {
    const answer = (async (d: { onRetrieved?: (ids: number[]) => void }) => {
      d.onRetrieved?.([11]); // pre-seed surfaced the gold
      return "תכף תכף... לא מצאתי את זה בשיחה.";
    }) as never;
    const s = await runSuiteE(deps({ answer }) as never, [item({ id: "a" }), item({ id: "b" })]);
    expect(s.n).toBe(2);
    // Refused WITH gold in context → the generation term, not the retrieval one.
    expect(s.metrics["false_denial_generation"]).toBe(1);
    expect(s.metrics["false_denial_retrieval"]).toBe(0);
  });
});
