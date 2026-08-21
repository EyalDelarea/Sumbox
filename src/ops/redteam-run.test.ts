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
    // ...but it is REPORTED. Dropped silently, a probe that crashed on every run
    // appeared in no table at all while the CLI printed "All scored guards held
    // on every run" and exited 0 — a green security report from a suite that
    // never scored anything.
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ target: p.target, run: 1, message: "ollama down" });
  });

  it("does not let a partial crash shrink the denominator unseen", async () => {
    // 2 of 3 runs score, 1 crashes: the score said runs:2 passRate:1.00 and the
    // missing third left no trace anywhere in the report.
    const p = probe({ verdict: () => "pass" });
    let n = 0;
    const d = {
      ...deps([], [p]),
      answer: (async () => {
        n += 1;
        if (n === 2) throw new Error("blip");
        return { text: "תכף תכף... בסדר." };
      }) as never,
    };
    const r = await runRedteamScored(d, 3);
    expect(r.scores[0]).toMatchObject({ runs: 2, passed: 2 });
    expect(r.errors).toEqual([{ target: p.target, run: 2, message: "blip" }]);
  });

  it("defaults the asker to a REAL roster member, not an invented name", async () => {
    // An invented asker is not ON the roster, and PEOPLE-SAFETY says to treat
    // anyone not on that list as a non-member — so a synthetic name swaps one
    // prompt-that-never-ships for another. Production's asker is always a member.
    const answer = vi.fn(async () => ({ text: "תכף תכף... בסדר." }));
    await runRedteamScored(
      {
        ...deps([], [probe({ verdict: () => "pass" })]),
        answer: answer as never,
        roster: async () => ["Royi", "Eyal"],
      },
      1,
    );
    expect(answer.mock.calls[0]![1]).toMatchObject({ askerName: "Royi" });
  });

  it("passes an askerName through, so the prompt matches the one that ships", async () => {
    // Production always passes an asker, so askerLine is always in the live
    // prompt. Without it the harness scored a prompt that never ships — the exact
    // complaint the harness exists to answer.
    const answer = vi.fn(async () => ({ text: "תכף תכף... בסדר." }));
    await runRedteamScored(
      {
        ...deps([], [probe({ verdict: () => "pass" })]),
        answer: answer as never,
        askerName: "בודק",
      },
      1,
    );
    expect(answer.mock.calls[0]![1]).toMatchObject({ askerName: "בודק" });
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
