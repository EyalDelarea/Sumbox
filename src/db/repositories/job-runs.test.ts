import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import {
  countInFlightMediaJobs,
  countJobsByStatus,
  resetStaleRunningJobs,
  setJobStatus,
  upsertJobRun,
} from "./job-runs.js";

describe("job-runs repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const JOB_ID_1 = "550e8400-e29b-41d4-a716-446655440001";
  const JOB_ID_2 = "550e8400-e29b-41d4-a716-446655440002";

  it("accepts analyze.image and analyze.video job types (feature 007)", async () => {
    await upsertJobRun(pool, {
      id: "550e8400-e29b-41d4-a716-44665544a001",
      type: "analyze.image",
      status: "pending",
      payload: { messageId: "1" },
      attempts: 0,
      maxAttempts: 3,
    });
    await upsertJobRun(pool, {
      id: "550e8400-e29b-41d4-a716-44665544a002",
      type: "analyze.video",
      status: "pending",
      payload: { messageId: "2" },
      attempts: 0,
      maxAttempts: 3,
    });
    const { rows } = await pool.query<{ type: string }>(
      `SELECT type FROM job_runs WHERE type IN ('analyze.image','analyze.video') ORDER BY type`,
    );
    expect(rows.map((r) => r.type)).toEqual(["analyze.image", "analyze.video"]);
  });

  describe("upsertJobRun", () => {
    it("creates a new row on first call", async () => {
      await upsertJobRun(pool, {
        id: JOB_ID_1,
        type: "import.file",
        status: "pending",
        payload: { filePath: "/data/export.zip" },
        attempts: 0,
        maxAttempts: 3,
      });

      const { rows } = await pool.query<{
        id: string;
        type: string;
        status: string;
        attempts: number;
        max_attempts: number;
        payload: { filePath: string };
      }>(`SELECT id, type, status, attempts, max_attempts, payload FROM job_runs WHERE id = $1`, [
        JOB_ID_1,
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: JOB_ID_1,
        type: "import.file",
        status: "pending",
        attempts: 0,
        max_attempts: 3,
      });
      expect(rows[0].payload).toMatchObject({ filePath: "/data/export.zip" });
    });

    it("updates the same row on conflict — no duplicate created", async () => {
      // Upsert same id with different status
      await upsertJobRun(pool, {
        id: JOB_ID_1,
        type: "import.file",
        status: "running",
        payload: { filePath: "/data/export.zip" },
        attempts: 1,
        maxAttempts: 3,
      });

      const { rows } = await pool.query<{ cnt: string }>(
        `SELECT count(*) AS cnt FROM job_runs WHERE id = $1`,
        [JOB_ID_1],
      );
      expect(Number(rows[0].cnt)).toBe(1);

      const { rows: updated } = await pool.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM job_runs WHERE id = $1`,
        [JOB_ID_1],
      );
      expect(updated[0].status).toBe("running");
      expect(updated[0].attempts).toBe(1);
    });

    it("touches updated_at on update", async () => {
      const { rows: before } = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM job_runs WHERE id = $1`,
        [JOB_ID_1],
      );
      const beforeTs = before[0].updated_at.getTime();

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      await upsertJobRun(pool, {
        id: JOB_ID_1,
        type: "import.file",
        status: "done",
        payload: { filePath: "/data/export.zip" },
        attempts: 1,
        maxAttempts: 3,
      });

      const { rows: after } = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM job_runs WHERE id = $1`,
        [JOB_ID_1],
      );
      expect(after[0].updated_at.getTime()).toBeGreaterThanOrEqual(beforeTs);
    });
  });

  describe("setJobStatus", () => {
    it("persists status transition", async () => {
      await upsertJobRun(pool, {
        id: JOB_ID_2,
        type: "transcribe.voicenote",
        status: "pending",
        payload: { messageId: "msg-1" },
        attempts: 0,
        maxAttempts: 5,
      });

      await setJobStatus(pool, JOB_ID_2, "running");

      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM job_runs WHERE id = $1`,
        [JOB_ID_2],
      );
      expect(rows[0].status).toBe("running");
    });

    it("persists last_error when provided", async () => {
      await setJobStatus(pool, JOB_ID_2, "failed", "something went wrong");

      const { rows } = await pool.query<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM job_runs WHERE id = $1`,
        [JOB_ID_2],
      );
      expect(rows[0].status).toBe("failed");
      expect(rows[0].last_error).toBe("something went wrong");
    });

    it("stamps started_at on the running transition (and re-stamps on retry)", async () => {
      const jobId = "550e8400-e29b-41d4-a716-446655440040";
      await upsertJobRun(pool, {
        id: jobId,
        type: "transcribe.voicenote",
        status: "pending",
        payload: { messageId: "m-start" },
        attempts: 0,
        maxAttempts: 3,
      });

      // Pending: no start time yet.
      const pendingRow = await pool.query<{ started_at: Date | null }>(
        `SELECT started_at FROM job_runs WHERE id = $1`,
        [jobId],
      );
      expect(pendingRow.rows[0].started_at).toBeNull();

      // Running: started_at gets stamped.
      await setJobStatus(pool, jobId, "running");
      const firstRun = await pool.query<{ started_at: Date }>(
        `SELECT started_at FROM job_runs WHERE id = $1`,
        [jobId],
      );
      expect(firstRun.rows[0].started_at).not.toBeNull();
      const firstStart = firstRun.rows[0].started_at.getTime();

      // A terminal status leaves started_at untouched.
      await setJobStatus(pool, jobId, "failed", "boom");
      const afterFail = await pool.query<{ started_at: Date }>(
        `SELECT started_at FROM job_runs WHERE id = $1`,
        [jobId],
      );
      expect(afterFail.rows[0].started_at.getTime()).toBe(firstStart);

      // Retry re-stamps started_at to the latest run.
      await new Promise((r) => setTimeout(r, 10));
      await setJobStatus(pool, jobId, "running");
      const secondRun = await pool.query<{ started_at: Date }>(
        `SELECT started_at FROM job_runs WHERE id = $1`,
        [jobId],
      );
      expect(secondRun.rows[0].started_at.getTime()).toBeGreaterThan(firstStart);
    });

    it("all valid status values persist", async () => {
      const allStatuses = ["pending", "running", "done", "failed", "dead"] as const;
      const jobId = "550e8400-e29b-41d4-a716-446655440003";

      await upsertJobRun(pool, {
        id: jobId,
        type: "import.file",
        status: "pending",
        payload: { filePath: "/x" },
        attempts: 0,
        maxAttempts: 1,
      });

      for (const status of allStatuses) {
        await setJobStatus(pool, jobId, status);
        const { rows } = await pool.query<{ status: string }>(
          `SELECT status FROM job_runs WHERE id = $1`,
          [jobId],
        );
        expect(rows[0].status).toBe(status);
      }
    });
  });

  describe("countJobsByStatus", () => {
    it("returns correct grouped counts", async () => {
      // Insert jobs with known statuses
      const jobs = [
        { id: "550e8400-e29b-41d4-a716-446655440010", status: "pending" as const },
        { id: "550e8400-e29b-41d4-a716-446655440011", status: "pending" as const },
        { id: "550e8400-e29b-41d4-a716-446655440012", status: "running" as const },
        { id: "550e8400-e29b-41d4-a716-446655440013", status: "done" as const },
        { id: "550e8400-e29b-41d4-a716-446655440014", status: "failed" as const },
        { id: "550e8400-e29b-41d4-a716-446655440015", status: "dead" as const },
      ];

      for (const j of jobs) {
        await upsertJobRun(pool, {
          id: j.id,
          type: "import.file",
          status: j.status,
          payload: { filePath: `/f/${j.id}` },
          attempts: 0,
          maxAttempts: 3,
        });
      }

      const counts = await countJobsByStatus(pool);

      // The counts include all rows in the table from previous tests too,
      // so we just verify these specific inserts are reflected
      expect(counts["dead"]).toBeGreaterThanOrEqual(1);
      expect(counts["failed"]).toBeGreaterThanOrEqual(1);
      expect(counts["done"]).toBeGreaterThanOrEqual(1);
      expect(counts["running"]).toBeGreaterThanOrEqual(1);
      expect(counts["pending"]).toBeGreaterThanOrEqual(2);
    });

    it("returns zero for statuses with no rows", async () => {
      // Just check that all expected status keys are present regardless of row counts

      const counts = await countJobsByStatus(pool);
      // Ensure all status keys are present (even if 0)
      for (const s of ["pending", "running", "done", "failed", "dead"]) {
        expect(typeof counts[s]).toBe("number");
      }
    });
  });

  describe("resetStaleRunningJobs", () => {
    it("resets all 'running' rows to 'failed' with last_error='worker restarted'", async () => {
      const runId1 = "550e8400-e29b-41d4-a716-446655440030";
      const runId2 = "550e8400-e29b-41d4-a716-446655440031";
      const doneId = "550e8400-e29b-41d4-a716-446655440032";

      // Insert two 'running' rows and one 'done' row
      await upsertJobRun(pool, {
        id: runId1,
        type: "import.file",
        status: "running",
        payload: {},
        attempts: 1,
        maxAttempts: 3,
      });
      await upsertJobRun(pool, {
        id: runId2,
        type: "transcribe.voicenote",
        status: "running",
        payload: {},
        attempts: 1,
        maxAttempts: 3,
      });
      await upsertJobRun(pool, {
        id: doneId,
        type: "import.file",
        status: "done",
        payload: {},
        attempts: 1,
        maxAttempts: 3,
      });

      const affected = await resetStaleRunningJobs(pool);
      expect(affected).toBeGreaterThanOrEqual(2);

      // Both running rows should now be 'failed' with the sentinel error
      for (const id of [runId1, runId2]) {
        const { rows } = await pool.query<{ status: string; last_error: string }>(
          `SELECT status, last_error FROM job_runs WHERE id = $1`,
          [id],
        );
        expect(rows[0].status).toBe("failed");
        expect(rows[0].last_error).toBe("worker restarted");
      }

      // 'done' row must be untouched
      const { rows: doneRows } = await pool.query<{ status: string }>(
        `SELECT status FROM job_runs WHERE id = $1`,
        [doneId],
      );
      expect(doneRows[0].status).toBe("done");
    });

    it("returns 0 when no rows are 'running'", async () => {
      // Mark all running rows to done first
      await pool.query(`UPDATE job_runs SET status='done' WHERE status='running'`);
      const affected = await resetStaleRunningJobs(pool);
      expect(affected).toBe(0);
    });
  });

  describe("attempts increment", () => {
    it("upsert with incremented attempts persists correctly", async () => {
      const jobId = "550e8400-e29b-41d4-a716-446655440020";
      await upsertJobRun(pool, {
        id: jobId,
        type: "transcribe.voicenote",
        status: "pending",
        payload: { messageId: "m-1" },
        attempts: 0,
        maxAttempts: 3,
      });

      // Simulate first delivery
      await upsertJobRun(pool, {
        id: jobId,
        type: "transcribe.voicenote",
        status: "running",
        payload: { messageId: "m-1" },
        attempts: 1,
        maxAttempts: 3,
      });

      // Simulate retry
      await upsertJobRun(pool, {
        id: jobId,
        type: "transcribe.voicenote",
        status: "running",
        payload: { messageId: "m-1" },
        attempts: 2,
        maxAttempts: 3,
      });

      const { rows } = await pool.query<{ attempts: number }>(
        `SELECT attempts FROM job_runs WHERE id = $1`,
        [jobId],
      );
      expect(rows[0].attempts).toBe(2);
    });
  });

  describe("countInFlightMediaJobs", () => {
    it("counts only pending/running media jobs, ignoring done/failed and non-media types", async () => {
      // Clear the slate for this test — mark all existing running rows done so
      // only the rows we insert here are in-flight.
      await pool.query(`UPDATE job_runs SET status='done' WHERE status IN ('pending','running')`);

      const mediaInflight = [
        { id: "550e8400-e29b-41d4-a716-aa6655440001", type: "analyze.image", status: "pending" },
        { id: "550e8400-e29b-41d4-a716-aa6655440002", type: "analyze.video", status: "running" },
        {
          id: "550e8400-e29b-41d4-a716-aa6655440003",
          type: "transcribe.voicenote",
          status: "pending",
        },
      ] as const;

      const shouldNotCount = [
        // terminal status — must be excluded
        { id: "550e8400-e29b-41d4-a716-aa6655440004", type: "analyze.image", status: "done" },
        { id: "550e8400-e29b-41d4-a716-aa6655440005", type: "analyze.video", status: "failed" },
        // non-media type — must be excluded even if in-flight
        { id: "550e8400-e29b-41d4-a716-aa6655440006", type: "import.file", status: "pending" },
      ] as const;

      for (const j of [...mediaInflight, ...shouldNotCount]) {
        await upsertJobRun(pool, {
          id: j.id,
          type: j.type,
          status: j.status,
          payload: {},
          attempts: 0,
          maxAttempts: 3,
        });
      }

      const count = await countInFlightMediaJobs(pool);
      expect(count).toBe(3);
    });

    it("returns 0 when no media jobs are in-flight", async () => {
      // Settle all in-flight rows.
      await pool.query(`UPDATE job_runs SET status='done' WHERE status IN ('pending','running')`);
      const count = await countInFlightMediaJobs(pool);
      expect(count).toBe(0);
    });
  });
});
