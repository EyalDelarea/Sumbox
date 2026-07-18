import { describe, expect, it } from "vitest";
import type { GoldenItem } from "./golden.js";
import {
  evaluateAll,
  falseAffirmation,
  falseDenialGeneration,
  falseDenialRetrieval,
  retrievalHit,
  searchedOnOwnInitiative,
  summarize,
  type TaskOutput,
} from "./suite-e.js";

// Pure evaluators: no DB, no model. Real @Aida phrasings as fixtures.

const present = (over: Partial<GoldenItem> = {}): GoldenItem => ({
  id: "p1",
  groupId: 70,
  question: "האם חלק מהשיחות פנו אליך ?",
  asOf: "2026-07-16T13:05:00Z",
  goldExternalIds: ["3ABC"],
  mustNotRefuse: true,
  expectedToolCalls: ["search_chat"],
  slice: ["recency:<5m"],
  provenance: { added: "2026-07-16", reason: "unit" },
  ...over,
});

const absent = (over: Partial<GoldenItem> = {}): GoldenItem =>
  present({ id: "a1", goldExternalIds: [], mustNotRefuse: false, ...over });

const out = (over: Partial<TaskOutput> = {}): TaskOutput => ({
  answer: "תכף תכף... לפי ההודעות, רועי שאל אם חלק מהשיחות פנו אליי.",
  retrievedIds: [1, 2],
  goldIds: [1],
  toolCalls: 1,
  citedIds: [1],
  ...over,
});

const DENIAL = "תכף תכף... לא מצאתי את זה בשיחה.";

describe("false_denial decomposition", () => {
  it("flags GENERATION when she refuses with gold in the retrieved set", () => {
    // The live bug: measured 67-100% on 2026-07-16.
    const r = falseDenialGeneration({ item: present(), output: out({ answer: DENIAL }) });
    expect(r.value).toBe(1);
    expect(r.comment).toMatch(/generation bug/);
  });

  it("does NOT flag generation when gold was never retrieved", () => {
    const output = out({ answer: DENIAL, retrievedIds: [9], goldIds: [1] });
    expect(falseDenialGeneration({ item: present(), output }).value).toBe(0);
    expect(falseDenialRetrieval({ item: present(), output }).value).toBe(1);
  });

  it("flags neither when she actually answered", () => {
    expect(falseDenialGeneration({ item: present(), output: out() }).value).toBe(0);
    expect(falseDenialRetrieval({ item: present(), output: out() }).value).toBe(0);
  });

  it("never flags a D_absent item as a false denial — refusing there is correct", () => {
    const output = out({ answer: DENIAL, goldIds: [], retrievedIds: [9] });
    expect(falseDenialGeneration({ item: absent(), output }).value).toBe(0);
    expect(falseDenialRetrieval({ item: absent(), output }).value).toBe(0);
  });
});

describe("false_affirmation — the mirror", () => {
  it("flags answering a question whose subject is NOT in the chat", () => {
    // Without this, false_denial → 0 is trivially reached by agreeing with everything.
    const output = out({ answer: "תכף תכף... כן, סוכם על הטיול ביום שלישי.", goldIds: [] });
    expect(falseAffirmation({ item: absent(), output }).value).toBe(1);
  });

  it("does not flag a correct refusal on a D_absent item", () => {
    expect(
      falseAffirmation({ item: absent(), output: out({ answer: DENIAL, goldIds: [] }) }).value,
    ).toBe(0);
  });

  it("does not apply to items that have gold", () => {
    expect(falseAffirmation({ item: present(), output: out() }).value).toBe(0);
  });
});

describe("retrieval_hit", () => {
  it("is 1 when a gold id is in the retrieved set", () => {
    expect(retrievalHit({ item: present(), output: out() }).value).toBe(1);
  });
  it("is 0 when it is not", () => {
    expect(retrievalHit({ item: present(), output: out({ retrievedIds: [9] }) }).value).toBe(0);
  });
  it("is vacuously 1 for D_absent", () => {
    expect(retrievalHit({ item: absent(), output: out({ goldIds: [] }) }).comment).toMatch(/n\/a/);
  });
});

describe("searched_on_own_initiative", () => {
  it("is 0 when she never called search_chat beyond the pre-seed", () => {
    // Diagnostic, not a gate: the pre-seed hands her the results either way, so
    // this only says the agentic loop is not earning its autonomy.
    const r = searchedOnOwnInitiative({ item: present(), output: out({ toolCalls: 0 }) });
    expect(r.value).toBe(0);
    expect(r.comment).toMatch(/never called search_chat/);
  });

  it("is 1 when she chose to search on top of the pre-seed", () => {
    expect(searchedOnOwnInitiative({ item: present(), output: out({ toolCalls: 2 }) }).value).toBe(
      1,
    );
  });
});

describe("evaluateAll / summarize", () => {
  it("returns one evaluation per evaluator", () => {
    expect(evaluateAll({ item: present(), output: out() }).map((e) => e.name)).toEqual([
      "false_denial_generation",
      "false_denial_retrieval",
      "false_affirmation",
      "retrieval_hit",
      "searched_on_own_initiative",
      "cited_a_source",
      "cited_exactly_one",
    ]);
  });

  it("averages each metric across items", () => {
    const s = summarize([
      { id: "a", evaluations: evaluateAll({ item: present(), output: out({ answer: DENIAL }) }) },
      { id: "b", evaluations: evaluateAll({ item: present(), output: out() }) },
    ]);
    expect(s.n).toBe(2);
    expect(s.metrics["false_denial_generation"]).toBe(0.5);
    expect(s.metrics["retrieval_hit"]).toBe(1);
  });
});
