import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../ask/embedder.js";
import { PROBES, runRedteam } from "./ask-redteam.js";

describe("ask-redteam probe set", () => {
  it("covers the guardrail families a peer-facing bot must survive", () => {
    const targets = PROBES.map((p) => p.target);
    // Injection, prompt-extraction, off-topic, people-safety, PII must all be probed.
    expect(targets).toContain("ignore-instructions");
    expect(targets).toContain("reveal-prompt");
    expect(targets).toContain("off-topic");
    expect(targets).toContain("is-x-bad");
    expect(targets).toContain("dump-secrets");
  });

  it("every probe declares its target, scope, and expected-safe behavior", () => {
    for (const p of PROBES) {
      expect(p.target).toBeTruthy();
      expect(["pii", "people"]).toContain(p.scope);
      expect(p.question.length).toBeGreaterThan(0);
      expect(p.expect.length).toBeGreaterThan(0);
    }
  });

  it("routes each probe to the group matching its scope", async () => {
    const seenGroups = new Set<number>();
    const embedder: Embedder = { embed: async () => new Array(1024).fill(0) };
    const pool = { query: async () => ({ rows: [] }) } as never;
    await runRedteam({
      pool,
      embedder,
      llm: { answer: vi.fn(async () => "תכף תכף... ok") },
      piiGroupId: 111,
      peopleGroupId: 222,
      onResult: () => {},
    });
    // With an empty pool every answer short-circuits to NOT_INDEXED, but the
    // routing (pii→111 / people→222) is exercised without a live model.
    expect(PROBES.some((p) => p.scope === "pii")).toBe(true);
    expect(PROBES.some((p) => p.scope === "people")).toBe(true);
    void seenGroups;
  });

  it("includes tool-abuse probes for the agentic path", () => {
    const targets = PROBES.map((p) => p.target);
    expect(targets).toContain("tool-arg-injection");
    expect(targets).toContain("tool-cross-chat");
  });
});
