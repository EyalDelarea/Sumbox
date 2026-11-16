import { describe, expect, it } from "vitest";
import type { JobStatus } from "../db/repositories/job-runs.js";
import { type AwaitJobsDeps, abortableSleep, awaitJobsSettled } from "./await-jobs.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A scripted job_runs table on a fake clock: `timeline[i]` is the status map
 * returned on the i-th poll (the last entry repeats). sleep advances the clock.
 */
function scripted(timeline: Array<Record<string, JobStatus>>) {
  let clock = 0;
  let polls = 0;
  const sleeps: number[] = [];
  const asked: string[][] = [];
  const deps: AwaitJobsDeps = {
    getStatuses: async (ids) => {
      asked.push([...ids]);
      const snap = timeline[Math.min(polls, timeline.length - 1)] ?? {};
      polls++;
      return new Map(Object.entries(snap));
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, sleeps, asked, polls: () => polls, clock: () => clock };
}

const OPTS = { timeoutMs: 100, pollMs: 30 };

// ── awaitJobsSettled ────────────────────────────────────────────────────────

describe("awaitJobsSettled", () => {
  it("returns at once with no ids (no changed groups)", async () => {
    const s = scripted([{}]);
    expect(await awaitJobsSettled(s.deps, [], OPTS)).toEqual({ status: "settled" });
    expect(s.polls()).toBe(0);
  });

  it("waits while jobs are pending/running and returns once all are done or dead", async () => {
    const s = scripted([
      { a: "pending", b: "running" },
      { a: "done", b: "running" },
      { a: "done", b: "dead" },
    ]);
    expect(await awaitJobsSettled(s.deps, ["a", "b"], OPTS)).toEqual({ status: "settled" });
    expect(s.sleeps).toEqual([30, 30]);
    // Settled ids are not asked about again.
    expect(s.asked).toEqual([["a", "b"], ["a", "b"], ["b"]]);
  });

  it("keeps waiting on `failed` — that is a retry in flight, not a terminal state", async () => {
    const s = scripted([{ a: "failed" }, { a: "running" }, { a: "done" }]);
    expect(await awaitJobsSettled(s.deps, ["a"], OPTS)).toEqual({ status: "settled" });
    expect(s.polls()).toBe(3);
  });

  it("treats an id with no job_runs row as settled", async () => {
    const s = scripted([{}]);
    expect(await awaitJobsSettled(s.deps, ["ghost"], OPTS)).toEqual({ status: "settled" });
  });

  it("gives up at the timeout and names the unsettled jobs (a lost message stays pending)", async () => {
    const s = scripted([{ a: "done", b: "pending" }]);
    expect(await awaitJobsSettled(s.deps, ["a", "b"], OPTS)).toEqual({
      status: "timeout",
      unsettled: ["b"],
    });
    // Never sleeps past the deadline: 30 + 30 + 30 + 10 = 100.
    expect(s.sleeps).toEqual([30, 30, 30, 10]);
    expect(s.clock()).toBe(100);
  });

  it("a failing status read is reported and retried under the same deadline", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const s = scripted([]);
    const deps: AwaitJobsDeps = {
      ...s.deps,
      getStatuses: async () => {
        calls++;
        if (calls === 1) throw new Error("db blip");
        return new Map([["a", "done" as JobStatus]]);
      },
      onPollError: (e) => errors.push(e),
    };
    expect(await awaitJobsSettled(deps, ["a"], OPTS)).toEqual({ status: "settled" });
    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("a status read that keeps failing still ends at the timeout", async () => {
    const s = scripted([]);
    const deps: AwaitJobsDeps = {
      ...s.deps,
      getStatuses: () => Promise.reject(new Error("db down")),
    };
    expect(await awaitJobsSettled(deps, ["a"], OPTS)).toEqual({
      status: "timeout",
      unsettled: ["a"],
    });
  });

  it("stops when aborted and reports what was still unsettled", async () => {
    const ac = new AbortController();
    const s = scripted([{ a: "pending" }]);
    const deps: AwaitJobsDeps = {
      ...s.deps,
      sleep: async () => {
        ac.abort();
      },
    };
    expect(await awaitJobsSettled(deps, ["a"], { ...OPTS, signal: ac.signal })).toEqual({
      status: "aborted",
      unsettled: ["a"],
    });
  });
});

// ── abortableSleep ──────────────────────────────────────────────────────────

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    const t0 = Date.now();
    await abortableSleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it("resolves early on abort", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("resolves at once when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await abortableSleep(10_000, ac.signal);
  });
});
