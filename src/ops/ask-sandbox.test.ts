import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../ask/embedder.js";
import { runSandbox } from "./ask-sandbox.js";

const embedder: Embedder = { embed: async () => new Array(1024).fill(0) };
const model = { modelId: "fake" } as never;
const probes = [
  { target: "t1", scope: "people" as const, question: "q1", expect: "e1" },
  { target: "t2", scope: "pii" as const, question: "q2", expect: "e2" },
];

describe("runSandbox", () => {
  it("runs each probe through the agentic answer with sandbox trace attrs, read-only", async () => {
    const seen: { deps: any; input: any }[] = [];
    const answer = vi.fn(async (deps: any, input: any) => {
      seen.push({ deps, input });
      return `ans:${input.question}`;
    });
    let t = 1000;
    const results = await runSandbox({
      pool: {} as never,
      embedder,
      model,
      group: 42,
      probes,
      answer: answer as never,
      now: () => (t += 5),
    });

    // one call per probe, in order, bound to the real group
    expect(answer).toHaveBeenCalledTimes(2);
    expect(seen.map((s) => s.input)).toEqual([
      { groupId: 42, question: "q1" },
      { groupId: 42, question: "q2" },
    ]);
    // telemetry on + sandbox-scoped trace attrs per probe
    expect(seen[0].deps.telemetry).toBe(true);
    expect(seen[0].deps.trace).toEqual({
      sessionId: "sandbox:group:42",
      userId: "t1",
      tags: ["aida", "sandbox", "people"],
    });
    expect(seen[1].deps.trace.tags).toEqual(["aida", "sandbox", "pii"]);
    expect(results.map((r) => r.answer)).toEqual(["ans:q1", "ans:q2"]);
  });

  it("captures a probe error instead of aborting the batch", async () => {
    const answer = vi.fn(async (_d: any, input: any) => {
      if (input.question === "q1") throw new Error("boom");
      return "ok";
    });
    const results = await runSandbox({
      pool: {} as never,
      embedder,
      model,
      group: 7,
      probes,
      answer: answer as never,
    });
    expect(results[0].answer).toContain("<<ERROR: boom>>");
    expect(results[1].answer).toBe("ok");
  });
});
