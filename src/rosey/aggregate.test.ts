import { describe, expect, it } from "vitest";
import type { RoseySourceMessage } from "../db/repositories/rosey-tasks.js";
import { type AggregateDeps, aggregateMessages } from "./aggregate.js";
import { DEDUP_SYSTEM } from "./dedup.js";
import { SUGGEST_SYSTEM } from "./suggest.js";

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 8));
const msg = (id: number, d: number, content: string): RoseySourceMessage => ({
  messageId: id,
  sentAt: day(d),
  sender: "דנה",
  content,
  isVoice: false,
});

type Stored = { id: number; title: string; titleKey: string; raisedAt: Date };

/** An in-memory store + scripted model, so the orchestration is tested without Ollama. */
function harness(script: {
  suggest: (prompt: string) => string;
  dedup?: (prompt: string) => string;
  raisedBy?: number | null;
}) {
  const stored: Stored[] = [];
  const seen = new Set<string>();
  const calls = { suggest: 0, dedup: 0 };
  const errors: unknown[] = [];
  const deps: AggregateDeps = {
    generate: async (system, user) => {
      if (system === SUGGEST_SYSTEM) {
        calls.suggest++;
        return script.suggest(user);
      }
      if (system === DEDUP_SYSTEM) {
        calls.dedup++;
        return script.dedup?.(user) ?? '{"same_as": null}';
      }
      throw new Error("unexpected system prompt");
    },
    isTagged: (t) => t.includes("@Rosey"),
    resolveRaisedBy: async (ids) =>
      new Map(ids.map((i) => [i, script.raisedBy === undefined ? 7 : script.raisedBy])),
    liveTasksRaisedBetween: async (since, until) =>
      stored.filter((t) => t.raisedAt >= since && t.raisedAt <= until),
    insertSuggestion: async (input) => {
      const k = `${input.sourceMessageId}:${input.titleKey}`; // the store's identity
      if (seen.has(k)) return null;
      seen.add(k);
      const id = stored.length + 1;
      stored.push({ id, title: input.title, titleKey: input.titleKey, raisedAt: input.raisedAt });
      return id;
    },
    onBatchError: (err) => errors.push(err),
  };
  return { deps, stored, calls, errors };
}

const items = (...xs: Array<[number, string, string?]>) =>
  JSON.stringify({ items: xs.map(([m, text, kind]) => ({ m, text, kind: kind ?? "task" })) });

describe("aggregateMessages", () => {
  it("creates one suggestion per list item and reports what it dropped", async () => {
    const h = harness({
      suggest: () => items([1, "לקנות חלב"], [1, "לקנות ביצים"], [2, "לתקן ברז", "past"]),
    });
    const r = await aggregateMessages([msg(1, 1, "חלב וביצים"), msg(2, 1, "תיקנתי")], h.deps);
    expect(h.stored.map((t) => t.title)).toEqual(["לקנות חלב", "לקנות ביצים"]);
    expect(r).toMatchObject({ proposed: 2, created: 2, droppedByKind: { past: 1 } });
  });

  it("never sends a tagged message to the model", async () => {
    const prompts: string[] = [];
    const h = harness({
      suggest: (p) => {
        prompts.push(p);
        return items();
      },
    });
    const r = await aggregateMessages(
      [msg(1, 1, "@Rosey לקנות חלב"), msg(2, 1, "צריך לחם")],
      h.deps,
    );
    expect(r.taggedSkipped).toBe(1);
    expect(prompts.join("\n")).not.toContain("[1]");
  });

  it("dedups incrementally — later items see earlier ones, exact matches skip the model", async () => {
    const h = harness({ suggest: () => items([1, "לקנות חלב"], [2, "לקנות חלב!"]) });
    const r = await aggregateMessages([msg(1, 1, "a"), msg(2, 2, "b")], h.deps);
    expect(r.created).toBe(1);
    expect(r.merged.exact).toBe(1);
    expect(h.calls.dedup).toBe(0);
  });

  it("a recurring errand outside the dedup window is a NEW task", async () => {
    const h = harness({
      suggest: (p) => (p.includes("[1]") ? items([1, "לקנות חלב"]) : items([2, "לקנות חלב"])),
    });
    const r = await aggregateMessages([msg(1, 1, "a"), msg(2, 20, "b")], h.deps, { batchSize: 1 });
    expect(r.created).toBe(2);
  });

  it("follows the model's duplicate answer and counts unparseable answers as kept", async () => {
    const h = harness({
      suggest: () => items([1, "לקנות חלב"], [2, "חלב"], [3, "לחם"]),
      dedup: (p) => (p.includes("New item: חלב") ? '{"same_as": 1}' : "hmm"),
    });
    const r = await aggregateMessages([msg(1, 1, "a"), msg(2, 1, "b"), msg(3, 1, "c")], h.deps);
    expect(r.merged.model).toBe(1);
    expect(r.dedupUnparsed).toBe(1);
    expect(h.stored.map((t) => t.title)).toEqual(["לקנות חלב", "לחם"]);
  });

  it("a failed batch is counted and reported, and the other batches still run", async () => {
    let n = 0;
    const h = harness({
      suggest: () => {
        n++;
        if (n === 1) throw new Error("ollama down");
        return items([2, "לקנות לחם"]);
      },
    });
    const r = await aggregateMessages([msg(1, 1, "a"), msg(2, 1, "b")], h.deps, { batchSize: 1 });
    expect(r.batchFailures).toBe(1);
    expect(r.created).toBe(1);
    expect(h.errors).toHaveLength(1);
  });

  it("a reply without JSON is a batch failure, not 'no tasks'", async () => {
    const h = harness({ suggest: () => "Sorry, I can't." });
    const r = await aggregateMessages([msg(1, 1, "a")], h.deps);
    expect(r.batchFailures).toBe(1);
    expect(h.errors).toHaveLength(1);
  });

  it("re-reading the same messages does not duplicate stored items", async () => {
    const h = harness({ suggest: () => items([1, "לקנות חלב"]), dedup: () => '{"same_as": null}' });
    await aggregateMessages([msg(1, 1, "a")], h.deps, { dedupWindowDays: 0 });
    const r = await aggregateMessages([msg(1, 1, "a")], h.deps, { dedupWindowDays: 0 });
    expect(r.alreadyStored + r.merged.exact).toBe(1);
    expect(h.stored).toHaveLength(1);
  });

  it("counts suggestions whose sender could not be resolved", async () => {
    const h = harness({ suggest: () => items([1, "לקנות חלב"]), raisedBy: null });
    const r = await aggregateMessages([msg(1, 1, "a")], h.deps);
    expect(r.raisedByUnresolved).toBe(1);
  });
});
