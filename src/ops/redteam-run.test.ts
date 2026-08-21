import { describe, expect, it, vi } from "vitest";
import type { Probe } from "./ask-redteam.js";
import { runRedteamScored } from "./redteam-run.js";

const probe = (over: Partial<Probe> = {}): Probe => ({
  target: "t",
  scope: "people",
  question: "q",
  expect: "e",
  ...over,
});

const deps = (answers: string[], probes: Probe[]) => {
  let i = 0;
  return {
    pool: {} as never,
    embedder: {} as never,
    model: {} as never,
    group: 70,
    probes,
    roster: async () => ["Royi"],
    answer: (async () => ({ text: answers[i++] ?? "", citedIds: [] })) as never,
  };
};

describe("runRedteamScored", () => {
  it("reports a pass RATE, so a guard that holds 2 of 3 times is visible", async () => {
    // The model is measurably non-deterministic, so "did it pass?" is the wrong
    // question — a flaky guard is a broken guard and only repetition shows it.
    const p = probe({ target: "hacked", verdict: (a) => (a.includes("HACKED") ? "fail" : "pass") });
    const r = await runRedteamScored(deps(["ok", "HACKED", "ok"], [p]), 3);
    expect(r.scores[0]).toMatchObject({ target: "hacked", runs: 3, passed: 2 });
  });

  it("keeps unscoreable probes as manual, never guessing a verdict", async () => {
    const r = await runRedteamScored(
      deps(["playful answer", "another"], [probe({ target: "vibe" })]),
      2,
    );
    expect(r.scores).toHaveLength(0);
    expect(r.manual[0]).toMatchObject({ target: "vibe" });
    expect(r.manual[0]!.answers).toHaveLength(2);
  });

  it("does not score a crash as a guard failure", async () => {
    // An unrelated outage must not look like a security regression.
    const p = probe({ verdict: () => "pass" });
    const d = {
      ...deps([], [p]),
      answer: (async () => {
        throw new Error("ollama down");
      }) as never,
    };
    const r = await runRedteamScored(d, 2);
    expect(r.scores).toHaveLength(0);
  });

  it("builds the roster once, not once per probe per run", async () => {
    const roster = vi.fn(async () => ["Royi"]);
    await runRedteamScored(
      { ...deps(["a", "b", "c", "d"], [probe(), probe({ target: "u" })]), roster },
      2,
    );
    expect(roster).toHaveBeenCalledOnce();
  });
});
