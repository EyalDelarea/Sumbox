import { describe, expect, it } from "vitest";
import type { NonTerminalJobRun } from "../db/repositories/job-runs.js";
import type { Job, JobType } from "../jobs/job-types.js";
import {
  type RequeueBus,
  type RequeueOrphansDeps,
  requeueOrphanedJobs,
  selectOrphans,
} from "./requeue-orphans.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-27T12:00:00Z");
const GRACE_MS = 5 * 60 * 1000;

function minutesAgo(m: number): Date {
  return new Date(NOW.getTime() - m * 60 * 1000);
}

/** `n` rows of `type`, oldest first, created 60, 59, 58 … minutes ago. */
function rowsOf(type: JobType, n: number, startMinutesAgo = 60): NonTerminalJobRun[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${type}-${i}`,
    type,
    status: "pending" as const,
    payload: { messageId: String(i) },
    maxAttempts: 3,
    createdAt: minutesAgo(startMinutesAgo - i),
  }));
}

/** A broker whose ready count rises as messages are republished, like the real one. */
class FakeBus implements RequeueBus {
  readonly published: Job[] = [];
  constructor(
    private readonly ready: Partial<Record<JobType, number>> = {},
    private readonly consumers: Partial<Record<JobType, number>> = {},
  ) {}
  async queueStats(type: JobType) {
    return { ready: this.ready[type] ?? 0, consumers: this.consumers[type] ?? 0 };
  }
  async republish(job: Job) {
    this.published.push(job);
    this.ready[job.type] = (this.ready[job.type] ?? 0) + 1;
  }
}

function makeDeps(
  rows: Partial<Record<JobType, NonTerminalJobRun[]>>,
  bus: RequeueBus,
  overrides: Partial<RequeueOrphansDeps> = {},
) {
  const lines: Array<{ level: string; msg: string }> = [];
  const listed: JobType[] = [];
  const deps: RequeueOrphansDeps = {
    types: ["transcribe.voicenote", "analyze.image", "analyze.video"],
    listNonTerminal: async (type) => {
      listed.push(type);
      return rows[type] ?? [];
    },
    bus,
    now: () => NOW,
    graceMs: GRACE_MS,
    log: {
      info: (_o: unknown, msg?: string) => lines.push({ level: "info", msg: msg ?? "" }),
      warn: (_o: unknown, msg?: string) => lines.push({ level: "warn", msg: msg ?? "" }),
      error: (_o: unknown, msg?: string) => lines.push({ level: "error", msg: msg ?? "" }),
    } as RequeueOrphansDeps["log"],
    ...overrides,
  };
  return { deps, lines, listed };
}

// ── selectOrphans ────────────────────────────────────────────────────────────

describe("selectOrphans", () => {
  const cutoff = minutesAgo(5);

  it("returns the oldest (rows − queued) rows", () => {
    const rows = rowsOf("analyze.image", 5);
    expect(selectOrphans(rows, 2, cutoff).map((r) => r.id)).toEqual([
      "analyze.image-0",
      "analyze.image-1",
      "analyze.image-2",
    ]);
  });

  it("returns nothing when the queue holds a message for every row (a healthy backlog)", () => {
    expect(selectOrphans(rowsOf("analyze.image", 5), 5, cutoff)).toEqual([]);
    expect(selectOrphans(rowsOf("analyze.image", 5), 9, cutoff)).toEqual([]);
  });

  it("never returns a row created inside the grace window", () => {
    // Created 7, 6, 5, 4, 3 minutes ago; queue empty → all 5 are 'missing'.
    const rows = rowsOf("analyze.image", 5, 7);
    expect(selectOrphans(rows, 0, cutoff).map((r) => r.id)).toEqual([
      "analyze.image-0",
      "analyze.image-1",
      "analyze.image-2",
    ]);
  });
});

// ── requeueOrphanedJobs ──────────────────────────────────────────────────────

describe("requeueOrphanedJobs", () => {
  it("re-sends exactly the lost messages, under their own ids, from attempt 0", async () => {
    // The 2026-10-27 incident shape: voice queue wiped; image queue kept the newer half.
    const voice = rowsOf("transcribe.voicenote", 4);
    const images = rowsOf("analyze.image", 6);
    const bus = new FakeBus({ "analyze.image": 2 });
    const { deps } = makeDeps({ "transcribe.voicenote": voice, "analyze.image": images }, bus);

    const outcomes = await requeueOrphanedJobs(deps);

    expect(bus.published.map((j) => j.id)).toEqual([
      ...voice.map((r) => r.id),
      "analyze.image-0",
      "analyze.image-1",
      "analyze.image-2",
      "analyze.image-3",
    ]);
    expect(bus.published[0]).toEqual({
      id: "transcribe.voicenote-0",
      type: "transcribe.voicenote",
      payload: { messageId: "0" },
      attempts: 0,
      maxAttempts: 3,
    });
    expect(outcomes).toContainEqual({
      type: "analyze.image",
      status: "requeued",
      tracked: 6,
      queued: 2,
      requeued: 4,
    });
  });

  it("does not duplicate a backlog whose messages are all still queued", async () => {
    const bus = new FakeBus({ "analyze.image": 500 });
    const { deps } = makeDeps({ "analyze.image": rowsOf("analyze.image", 500) }, bus);

    await requeueOrphanedJobs(deps);

    expect(bus.published).toEqual([]);
  });

  it("converges: a second startup re-sends nothing", async () => {
    const rows = { "transcribe.voicenote": rowsOf("transcribe.voicenote", 3) };
    const bus = new FakeBus();
    await requeueOrphanedJobs(makeDeps(rows, bus).deps);
    expect(bus.published).toHaveLength(3);

    await requeueOrphanedJobs(makeDeps(rows, bus).deps);
    expect(bus.published).toHaveLength(3);
  });

  it("leaves rows inside the grace window alone", async () => {
    const bus = new FakeBus();
    const fresh = rowsOf("transcribe.voicenote", 2, 1); // 1 and 0 minutes old
    const { deps } = makeDeps({ "transcribe.voicenote": fresh }, bus);

    await requeueOrphanedJobs(deps);

    expect(bus.published).toEqual([]);
  });

  it("skips a type another live consumer is attached to (its unacked messages are uncountable)", async () => {
    const bus = new FakeBus({}, { "analyze.image": 1 });
    const { deps, lines } = makeDeps({ "analyze.image": rowsOf("analyze.image", 3) }, bus);

    const outcomes = await requeueOrphanedJobs(deps);

    expect(bus.published).toEqual([]);
    expect(outcomes).toContainEqual({
      type: "analyze.image",
      status: "skipped-live-consumer",
      consumers: 1,
    });
    expect(lines.some((l) => l.level === "warn" && l.msg.includes("analyze.image"))).toBe(true);
  });

  it("only touches types this worker consumes that opt in to startup requeue", async () => {
    const bus = new FakeBus();
    const { deps, listed } = makeDeps(
      {
        "summarize.total": rowsOf("summarize.total", 2),
        "summarize.group": rowsOf("summarize.group", 2),
        "analyze.video": rowsOf("analyze.video", 2),
      },
      bus,
      // analyze.video is requeueable but not consumed here; the summaries are
      // consumed but not requeueable.
      { types: ["summarize.total", "summarize.group", "transcribe.voicenote"] },
    );

    await requeueOrphanedJobs(deps);

    expect(listed).toEqual(["transcribe.voicenote"]);
    expect(bus.published).toEqual([]);
  });

  it("logs one line per type with the requeued count, including zero", async () => {
    const bus = new FakeBus({ "analyze.image": 1 });
    const { deps, lines } = makeDeps(
      {
        "transcribe.voicenote": rowsOf("transcribe.voicenote", 2),
        "analyze.image": rowsOf("analyze.image", 1),
      },
      bus,
    );

    await requeueOrphanedJobs(deps);

    expect(lines.filter((l) => l.level === "info").map((l) => l.msg)).toEqual([
      "Re-queued 2 orphaned transcribe.voicenote job(s) on startup (2 open in job_runs, 0 in queue).",
      "Re-queued 0 orphaned analyze.image job(s) on startup (1 open in job_runs, 1 in queue).",
      "Re-queued 0 orphaned analyze.video job(s) on startup (0 open in job_runs, 0 in queue).",
    ]);
  });

  it("a failure on one type is logged and the others still run", async () => {
    const bus = new FakeBus();
    const { deps, lines } = makeDeps({ "analyze.image": rowsOf("analyze.image", 2) }, bus, {
      types: ["transcribe.voicenote", "analyze.image"],
      listNonTerminal: async (type) => {
        if (type === "transcribe.voicenote") throw new Error("db down");
        return rowsOf("analyze.image", 2);
      },
    });

    const outcomes = await requeueOrphanedJobs(deps);

    expect(outcomes[0]).toEqual({
      type: "transcribe.voicenote",
      status: "error",
      error: "db down",
      requeued: 0,
    });
    expect(bus.published).toHaveLength(2);
    expect(lines.some((l) => l.level === "error" && l.msg.includes("db down"))).toBe(true);
  });

  it("a mid-loop publish failure reports how many were already re-sent", async () => {
    const bus = new FakeBus();
    const real = bus.republish.bind(bus);
    bus.republish = async (job: Job) => {
      if (bus.published.length === 2) throw new Error("channel closed");
      await real(job);
    };
    const { deps, lines } = makeDeps(
      { "transcribe.voicenote": rowsOf("transcribe.voicenote", 5) },
      bus,
      {
        types: ["transcribe.voicenote"],
      },
    );

    const outcomes = await requeueOrphanedJobs(deps);

    expect(outcomes).toEqual([
      { type: "transcribe.voicenote", status: "error", error: "channel closed", requeued: 2 },
    ]);
    expect(lines.some((l) => l.level === "error" && l.msg.includes("after re-sending 2"))).toBe(
      true,
    );
  });

  it("reads job_runs BEFORE inspecting the queue, so a publish wholly in between can only under-count", async () => {
    const calls: string[] = [];
    const bus = new FakeBus();
    const stats = bus.queueStats.bind(bus);
    bus.queueStats = async (type: JobType) => {
      calls.push(`stats:${type}`);
      return stats(type);
    };
    const { deps } = makeDeps({}, bus, {
      types: ["transcribe.voicenote"],
      listNonTerminal: async (type) => {
        calls.push(`rows:${type}`);
        return [];
      },
    });

    await requeueOrphanedJobs(deps);

    expect(calls).toEqual(["rows:transcribe.voicenote", "stats:transcribe.voicenote"]);
  });
});
