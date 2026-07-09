import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertJobRun } from "../db/repositories/job-runs.js";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { createTestDatabase } from "../test/db.js";
import { redriveDeadJobs } from "./redrive.js";

// Helper: insert a dead job_runs row directly via upsertJobRun
async function seedDeadJob(
  pool: pg.Pool,
  opts: {
    id?: string;
    type?: string;
    messageId?: string;
    redriveCount?: number;
    lastError?: string;
    payload?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const type = (opts.type ?? "transcribe.voicenote") as Parameters<typeof upsertJobRun>[1]["type"];
  const payload: Record<string, unknown> = opts.payload ?? {};
  if (opts.messageId !== undefined) payload.messageId = opts.messageId;
  if (opts.redriveCount !== undefined) payload.redriveCount = opts.redriveCount;

  await upsertJobRun(pool, {
    id,
    type,
    status: "dead",
    payload,
    attempts: 3,
    maxAttempts: 3,
    lastError: opts.lastError ?? null,
  });
  return id;
}

describe("redriveDeadJobs", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  function makeBus(): { bus: InMemoryJobBus; recorder: InMemoryJobRunRecorder } {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    return { bus, recorder };
  }

  it("returns { redriven:0, flagged:0, flaggedDetails:[] } when no dead rows", async () => {
    // Use a fresh table by checking only rows we know exist — but since
    // testcontainers gives a shared DB per file, filter by our seeded IDs instead.
    // Actually the test DB is clean at this point.
    const { bus } = makeBus();
    // Ensure no dead rows by truncating-safe: run with an empty state
    // We can't easily isolate, so insert none and check the result is 0.
    // (This test assumes no dead rows exist from prior tests — it runs first.)
    const result = await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });
    expect(result.redriven).toBe(0);
    expect(result.flagged).toBe(0);
    expect(result.flaggedDetails).toEqual([]);
  });

  it("n=0 (no redriveCount): re-drives with redriveCount=1 and deletes the dead row", async () => {
    const { bus, recorder } = makeBus();
    const deadId = await seedDeadJob(pool, {
      messageId: "msg-rdrive-1",
      type: "transcribe.voicenote",
    });

    const result = await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });

    // redriven count incremented
    expect(result.redriven).toBeGreaterThanOrEqual(1);
    expect(result.flagged).toBe(0);

    // The dead row should be deleted
    const { rows } = await pool.query(`SELECT id FROM job_runs WHERE id = $1`, [deadId]);
    expect(rows).toHaveLength(0);

    // Bus received a re-enqueue with redriveCount=1
    const enqueued = recorder.enqueuedJobs;
    const redriven = enqueued.filter(
      (e) =>
        (e.job.payload as Record<string, unknown>).messageId === "msg-rdrive-1" &&
        (e.job.payload as Record<string, unknown>).redriveCount === 1,
    );
    expect(redriven).toHaveLength(1);
    expect(redriven[0].job.type).toBe("transcribe.voicenote");
  });

  it("n=1: re-drives with redriveCount=2", async () => {
    const { bus, recorder } = makeBus();
    await seedDeadJob(pool, {
      messageId: "msg-rdrive-2",
      type: "transcribe.voicenote",
      redriveCount: 1,
    });

    await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });

    const enqueued = recorder.enqueuedJobs;
    const redriven = enqueued.filter(
      (e) =>
        (e.job.payload as Record<string, unknown>).messageId === "msg-rdrive-2" &&
        (e.job.payload as Record<string, unknown>).redriveCount === 2,
    );
    expect(redriven).toHaveLength(1);
  });

  it("n=2 (== cap default 2): flagged, NOT deleted or re-enqueued", async () => {
    const { bus, recorder } = makeBus();
    const deadId = await seedDeadJob(pool, {
      messageId: "msg-cap-hit",
      type: "transcribe.voicenote",
      redriveCount: 2,
      lastError: "persistent failure",
    });

    const result = await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });

    expect(result.flagged).toBeGreaterThanOrEqual(1);

    // Dead row must remain
    const { rows } = await pool.query(`SELECT id FROM job_runs WHERE id = $1`, [deadId]);
    expect(rows).toHaveLength(1);

    // No re-enqueue for this work-item
    const enqueued = recorder.enqueuedJobs;
    const wrongEnqueue = enqueued.filter(
      (e) => (e.job.payload as Record<string, unknown>).messageId === "msg-cap-hit",
    );
    expect(wrongEnqueue).toHaveLength(0);

    // flaggedDetails includes this item
    const detail = result.flaggedDetails.find((d) => d.messageId === "msg-cap-hit");
    expect(detail).toBeDefined();
    expect(detail?.redriveCount).toBe(2);
    expect(detail?.lastError).toBe("persistent failure");
    expect(detail?.type).toBe("transcribe.voicenote");
  });

  it("groups by messageId: multiple dead rows for same work-item collapse to one re-enqueue", async () => {
    const { bus, recorder } = makeBus();
    const msgId = "msg-group-test";
    // Two dead rows for the same messageId (e.g. failed twice with redriveCount 0 and 1)
    await seedDeadJob(pool, {
      messageId: msgId,
      type: "transcribe.voicenote",
      redriveCount: 0,
    });
    await seedDeadJob(pool, {
      messageId: msgId,
      type: "transcribe.voicenote",
      redriveCount: 1,
    });

    const result = await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });

    // Both rows deleted, only one re-enqueue with redriveCount = max(0,1)+1 = 2
    const { rows } = await pool.query(
      `SELECT id FROM job_runs WHERE payload->>'messageId' = $1 AND status = 'dead'`,
      [msgId],
    );
    expect(rows).toHaveLength(0);

    const enqueued = recorder.enqueuedJobs.filter(
      (e) => (e.job.payload as Record<string, unknown>).messageId === msgId,
    );
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0].job.payload as Record<string, unknown>).redriveCount).toBe(2);

    // Counts as 1 re-driven work-item
    expect(result.redriven).toBeGreaterThanOrEqual(1);
  });

  it("payload WITHOUT messageId still works (uses JSON.stringify identity)", async () => {
    const { bus, recorder } = makeBus();
    // import.file has filePath, no messageId
    const deadId = await seedDeadJob(pool, {
      type: "import.file",
      payload: { filePath: "/data/export.zip" },
    });

    const result = await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });

    expect(result.redriven).toBeGreaterThanOrEqual(1);

    // Dead row deleted
    const { rows } = await pool.query(`SELECT id FROM job_runs WHERE id = $1`, [deadId]);
    expect(rows).toHaveLength(0);

    // Re-enqueued with redriveCount=1
    const enqueued = recorder.enqueuedJobs.filter(
      (e) =>
        e.job.type === "import.file" &&
        (e.job.payload as Record<string, unknown>).filePath === "/data/export.zip" &&
        (e.job.payload as Record<string, unknown>).redriveCount === 1,
    );
    expect(enqueued).toHaveLength(1);
  });

  it("n >= cap: redriveCount and lastError appear in flaggedDetails", async () => {
    const { bus } = makeBus();
    await seedDeadJob(pool, {
      messageId: "msg-flagged-detail",
      type: "analyze.image",
      redriveCount: 3,
      lastError: "vision model crashed",
    });

    const result = await redriveDeadJobs({ pool, bus, cap: 2, now: () => new Date() });

    const detail = result.flaggedDetails.find((d) => d.messageId === "msg-flagged-detail");
    expect(detail).toBeDefined();
    expect(detail?.redriveCount).toBe(3);
    expect(detail?.lastError).toBe("vision model crashed");
    expect(detail?.type).toBe("analyze.image");
  });

  it("enqueue-before-delete safety: if bus.enqueue throws, dead row is NOT deleted", async () => {
    // Stub bus whose enqueue always rejects
    const throwingBus: import("../jobs/job-bus.js").JobBus = {
      enqueue: async () => {
        throw new Error("bus is down");
      },
      consume: async () => {},
      depth: async () => 0,
      close: async () => {},
    };

    const deadId = await seedDeadJob(pool, {
      messageId: "msg-enqueue-fail-safety",
      type: "transcribe.voicenote",
    });

    // redriveDeadJobs should reject because enqueue threw
    await expect(
      redriveDeadJobs({ pool, bus: throwingBus, cap: 2, now: () => new Date() }),
    ).rejects.toThrow("bus is down");

    // The dead row must still exist — work item is NOT lost
    const { rows } = await pool.query(`SELECT id FROM job_runs WHERE id = $1`, [deadId]);
    expect(rows).toHaveLength(1);
  });
});
