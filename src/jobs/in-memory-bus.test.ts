import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertJobRun } from "../db/repositories/job-runs.js";
import { createTestDatabase } from "../test/db.js";
import { InMemoryJobBus } from "./in-memory-bus.js";
import { InMemoryJobRunRecorder, PostgresJobRunRecorder } from "./job-run-recorder.js";

// ─── InMemoryJobBus unit tests (no DB) ─────────────────────────────────────

describe("InMemoryJobBus — unit tests (InMemoryJobRunRecorder)", () => {
  describe("enqueue", () => {
    it("generates a uuid id and returns it", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const { id } = await bus.enqueue("import.file", { filePath: "/a/b.zip" });

      expect(typeof id).toBe("string");
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("records 'pending' status on enqueue", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const { id } = await bus.enqueue("import.file", { filePath: "/x.zip" });

      const history = recorder.historyFor(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ id, status: "pending" });
    });

    it("increases depth(type) after enqueueing", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      expect(await bus.depth("import.file")).toBe(0);

      await bus.enqueue("import.file", { filePath: "/1.zip" });
      expect(await bus.depth("import.file")).toBe(1);

      await bus.enqueue("import.file", { filePath: "/2.zip" });
      expect(await bus.depth("import.file")).toBe(2);

      // Other type unaffected
      expect(await bus.depth("transcribe.voicenote")).toBe(0);
    });
  });

  describe("consume — happy path", () => {
    it("runs the handler, drains queue, records running → done", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const { id } = await bus.enqueue("import.file", { filePath: "/c.zip" });

      const handledJobs: string[] = [];
      await bus.consume(
        "import.file",
        async (job) => {
          handledJobs.push(job.id);
        },
        { prefetch: 1 },
      );

      expect(handledJobs).toEqual([id]);
      expect(await bus.depth("import.file")).toBe(0);

      const history = recorder.historyFor(id);
      const statuses = history.map((e) => e.status);
      expect(statuses).toEqual(["pending", "running", "done"]);
    });

    it("drains multiple enqueued jobs in one consume call", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const ids = await Promise.all([
        bus.enqueue("import.file", { filePath: "/1.zip" }),
        bus.enqueue("import.file", { filePath: "/2.zip" }),
        bus.enqueue("import.file", { filePath: "/3.zip" }),
      ]);

      const handled: string[] = [];
      await bus.consume(
        "import.file",
        async (job) => {
          handled.push(job.id);
        },
        { prefetch: 1 },
      );

      expect(handled).toHaveLength(3);
      expect(await bus.depth("import.file")).toBe(0);

      for (const { id } of ids) {
        const statuses = recorder.historyFor(id).map((e) => e.status);
        expect(statuses).toEqual(["pending", "running", "done"]);
      }
    });
  });

  describe("consume — handler always throws (retry → DLQ)", () => {
    it("retries until maxAttempts then routes to DLQ with status 'dead'", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const MAX = 3;
      const { id } = await bus.enqueue(
        "import.file",
        { filePath: "/fail.zip" },
        { maxAttempts: MAX },
      );

      let callCount = 0;
      await bus.consume(
        "import.file",
        async () => {
          callCount++;
          throw new Error("always fails");
        },
        { prefetch: 1 },
      );

      // Handler called exactly maxAttempts times
      expect(callCount).toBe(MAX);

      // Job landed in DLQ
      expect(bus.deadLetters("import.file")).toHaveLength(1);
      expect(bus.deadLetters("import.file")[0].id).toBe(id);

      // Queue drained (not stuck retrying forever)
      expect(await bus.depth("import.file")).toBe(0);

      // Status transitions: pending, then for each attempt: running, failed (or dead on last)
      const statuses = recorder.historyFor(id).map((e) => e.status);
      // pending → running → failed → running → failed → running → dead
      expect(statuses).toEqual([
        "pending",
        "running",
        "failed",
        "running",
        "failed",
        "running",
        "dead",
      ]);
    });

    it("records last_error on failed attempts", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const { id } = await bus.enqueue(
        "import.file",
        { filePath: "/fail.zip" },
        { maxAttempts: 2 },
      );

      await bus.consume(
        "import.file",
        async () => {
          throw new Error("boom");
        },
        { prefetch: 1 },
      );

      const failedEntries = recorder
        .historyFor(id)
        .filter((e) => e.status === "failed" || e.status === "dead");

      for (const entry of failedEntries) {
        expect(entry.lastError).toBe("boom");
      }
    });

    it("is NOT retried further after reaching DLQ", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const MAX = 2;
      let callCount = 0;

      const { id } = await bus.enqueue(
        "transcribe.voicenote",
        { messageId: "msg-1" },
        { maxAttempts: MAX },
      );

      await bus.consume(
        "transcribe.voicenote",
        async () => {
          callCount++;
          throw new Error("nope");
        },
        { prefetch: 1 },
      );

      // Call consume a second time — dead job should NOT be re-processed
      await bus.consume(
        "transcribe.voicenote",
        async () => {
          callCount++;
          throw new Error("should not reach");
        },
        { prefetch: 1 },
      );

      expect(callCount).toBe(MAX);
      expect(bus.deadLetters("transcribe.voicenote")[0].id).toBe(id);
    });
  });

  describe("consume — handler throws once then succeeds", () => {
    it("eventually records 'done' after transient failure", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      const { id } = await bus.enqueue(
        "import.file",
        { filePath: "/transient.zip" },
        { maxAttempts: 3 },
      );

      let attempts = 0;
      await bus.consume(
        "import.file",
        async () => {
          attempts++;
          if (attempts === 1) throw new Error("transient");
        },
        { prefetch: 1 },
      );

      expect(attempts).toBe(2);
      expect(await bus.depth("import.file")).toBe(0);
      expect(bus.deadLetters("import.file")).toHaveLength(0);

      const statuses = recorder.historyFor(id).map((e) => e.status);
      // pending → running → failed → running → done
      expect(statuses).toEqual(["pending", "running", "failed", "running", "done"]);
    });
  });

  describe("depth and close", () => {
    it("depth reflects queued count, decreases after consume", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);

      await bus.enqueue("import.file", { filePath: "/1.zip" });
      await bus.enqueue("import.file", { filePath: "/2.zip" });
      await bus.enqueue("transcribe.voicenote", { messageId: "m1" });

      expect(await bus.depth("import.file")).toBe(2);
      expect(await bus.depth("transcribe.voicenote")).toBe(1);

      await bus.consume("import.file", async () => {}, { prefetch: 1 });

      expect(await bus.depth("import.file")).toBe(0);
      expect(await bus.depth("transcribe.voicenote")).toBe(1);
    });

    it("close() resolves without error", async () => {
      const recorder = new InMemoryJobRunRecorder();
      const bus = new InMemoryJobBus(recorder);
      await expect(bus.close()).resolves.toBeUndefined();
    });
  });
});

// ─── PostgresJobRunRecorder integration test ──────────────────────────────

describe("PostgresJobRunRecorder — integration (testcontainers)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("recordEnqueued writes a 'pending' job_runs row", async () => {
    const recorder = new PostgresJobRunRecorder(pool);
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01";

    const job = {
      id: jobId,
      type: "import.file" as const,
      payload: { filePath: "/test.zip" },
      attempts: 0,
      maxAttempts: 3,
    };

    await recorder.recordEnqueued(job, 3);

    const { rows } = await pool.query<{
      id: string;
      type: string;
      status: string;
      attempts: number;
      max_attempts: number;
    }>(`SELECT id, type, status, attempts, max_attempts FROM job_runs WHERE id = $1`, [jobId]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: jobId,
      type: "import.file",
      status: "pending",
      attempts: 0,
      max_attempts: 3,
    });
  });

  it("recordStatus updates the job_runs row status", async () => {
    const recorder = new PostgresJobRunRecorder(pool);
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02";

    // First create the row
    await upsertJobRun(pool, {
      id: jobId,
      type: "transcribe.voicenote",
      status: "pending",
      payload: { messageId: "msg-99" },
      attempts: 0,
      maxAttempts: 5,
    });

    await recorder.recordStatus(jobId, "running");

    const { rows: runningRows } = await pool.query<{ status: string }>(
      `SELECT status FROM job_runs WHERE id = $1`,
      [jobId],
    );
    expect(runningRows[0].status).toBe("running");

    await recorder.recordStatus(jobId, "done");

    const { rows: doneRows } = await pool.query<{ status: string }>(
      `SELECT status FROM job_runs WHERE id = $1`,
      [jobId],
    );
    expect(doneRows[0].status).toBe("done");
  });

  it("recordStatus stores last_error on failure", async () => {
    const recorder = new PostgresJobRunRecorder(pool);
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee03";

    await upsertJobRun(pool, {
      id: jobId,
      type: "import.file",
      status: "pending",
      payload: { filePath: "/x.zip" },
      attempts: 0,
      maxAttempts: 3,
    });

    await recorder.recordStatus(jobId, "failed", "something exploded");

    const { rows } = await pool.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM job_runs WHERE id = $1`,
      [jobId],
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toBe("something exploded");
  });
});
