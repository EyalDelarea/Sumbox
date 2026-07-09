import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertJobRun } from "../db/repositories/job-runs.js";
import { listStatusSnapshots } from "../db/repositories/status-snapshots.js";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { createTestDatabase } from "../test/db.js";
import { runOpsSweep } from "./sweep.js";

describe("runOpsSweep", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  function makeBus(): InMemoryJobBus {
    const recorder = new InMemoryJobRunRecorder();
    return new InMemoryJobBus(recorder);
  }

  const FIXED_NOW = new Date("2026-06-06T08:00:00Z");

  async function seedDeadJob(messageId: string, type = "transcribe.voicenote"): Promise<string> {
    const id = randomUUID();
    await upsertJobRun(pool, {
      id,
      type: type as Parameters<typeof upsertJobRun>[1]["type"],
      status: "dead",
      payload: { messageId },
      attempts: 3,
      maxAttempts: 3,
      lastError: "test error",
    });
    return id;
  }

  it("writes a snapshot row with correct redriven/flagged when dead rows exist", async () => {
    const bus = makeBus();
    const deadId = await seedDeadJob(`msg-sweep-${randomUUID()}`);

    const snapshot = await runOpsSweep({
      pool,
      bus,
      getQueueDepths: async () => ({ "import.file": 0, "transcribe.voicenote": 0 }),
      stalenessMs: 60_000,
      cap: 2,
      logger: undefined,
      now: () => FIXED_NOW,
    });

    expect(snapshot).toBeDefined();
    expect(snapshot.redriven).toBeGreaterThanOrEqual(1);

    // Verify snapshot was written to DB
    const rows = await listStatusSnapshots(pool, 5);
    const written = rows.find((r) => r.id === snapshot.id);
    expect(written).toBeDefined();
    expect(written?.redriven).toBe(snapshot.redriven);

    // Dead row should be deleted (redriven, not flagged)
    const { rows: deadRows } = await pool.query(`SELECT id FROM job_runs WHERE id = $1`, [deadId]);
    expect(deadRows).toHaveLength(0);
  });

  it("populates job counts from DB in the snapshot", async () => {
    const bus = makeBus();

    const snapshot = await runOpsSweep({
      pool,
      bus,
      getQueueDepths: async () => ({}),
      stalenessMs: 60_000,
      cap: 2,
      logger: undefined,
      now: () => FIXED_NOW,
    });

    // jobsDone, jobsFailed, etc. should be non-negative numbers
    expect(typeof snapshot.jobsPending).toBe("number");
    expect(typeof snapshot.jobsDone).toBe("number");
    expect(typeof snapshot.jobsDead).toBe("number");
    expect(snapshot.jobsPending).toBeGreaterThanOrEqual(0);
  });

  it("does NOT throw when getQueueDepths fails — snapshot still written", async () => {
    const bus = makeBus();
    const failingGetQueueDepths = async (): Promise<never> => {
      throw new Error("broker down");
    };

    let snapshot: Awaited<ReturnType<typeof runOpsSweep>> | undefined;
    await expect(
      (async () => {
        snapshot = await runOpsSweep({
          pool,
          bus,
          getQueueDepths: failingGetQueueDepths,
          stalenessMs: 60_000,
          cap: 2,
          logger: undefined,
          now: () => FIXED_NOW,
        });
      })(),
    ).resolves.toBeUndefined(); // must not throw

    // Snapshot still written
    expect(snapshot).toBeDefined();
    const rows = await listStatusSnapshots(pool, 5);
    const written = rows.find((r) => r.id === snapshot!.id);
    expect(written).toBeDefined();
    // queueDepths may be null or empty when broker is down
    // (best-effort — could be null or {})
  });

  it("calls logger.info once with a structured message", async () => {
    const bus = makeBus();
    const logger = { info: vi.fn() };

    await runOpsSweep({
      pool,
      bus,
      getQueueDepths: async () => ({}),
      stalenessMs: 60_000,
      cap: 2,
      logger,
      now: () => FIXED_NOW,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [arg] = logger.info.mock.calls[0];
    expect(arg).toMatchObject({ redriven: expect.any(Number), flagged: expect.any(Number) });
  });

  it("does NOT throw when redriveDeadJobs itself fails — still writes partial snapshot", async () => {
    // We can simulate by passing a bus whose enqueue throws
    const recorder = new InMemoryJobRunRecorder();
    const brokenBus = new InMemoryJobBus(recorder);
    // Override enqueue to throw
    const enqueueError = new Error("bus broken");
    vi.spyOn(brokenBus, "enqueue").mockRejectedValue(enqueueError);

    // Seed a dead job so redriveDeadJobs tries to enqueue
    await seedDeadJob(`msg-broken-${randomUUID()}`);

    let snapshot: Awaited<ReturnType<typeof runOpsSweep>> | undefined;
    await expect(
      (async () => {
        snapshot = await runOpsSweep({
          pool,
          bus: brokenBus,
          getQueueDepths: async () => ({}),
          stalenessMs: 60_000,
          cap: 2,
          logger: undefined,
          now: () => FIXED_NOW,
        });
      })(),
    ).resolves.toBeUndefined(); // must not throw

    // A partial snapshot should still be recorded
    expect(snapshot).toBeDefined();
    const rows = await listStatusSnapshots(pool, 5);
    const written = rows.find((r) => r.id === snapshot!.id);
    expect(written).toBeDefined();
  });
});
