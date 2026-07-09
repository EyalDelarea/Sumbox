/**
 * Regression test: every value in ALL_JOB_TYPES must be permitted by the
 * job_runs_type_check Postgres constraint. This test catches the class of
 * bug where a new JobType is added to the union but the corresponding
 * migration to widen the CHECK constraint is forgotten.
 *
 * If you add a new JobType, you MUST also add a migration that ALTERs
 * job_runs to include that type in the CHECK constraint.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db.js";
import { ALL_JOB_TYPES } from "./job-types.js";

// Sample minimal payloads for each job type (only used to satisfy NOT NULL on payload column)
const SAMPLE_PAYLOADS: Record<string, object> = {
  "import.file": { filePath: "/test.zip" },
  "transcribe.voicenote": { messageId: "msg-1" },
  "analyze.image": { messageId: "msg-2" },
  "analyze.video": { messageId: "msg-3" },
  "summarize.group": { groupId: "42" },
};

describe("job_runs type constraint covers ALL_JOB_TYPES", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  for (const jobType of ALL_JOB_TYPES) {
    it(`allows inserting a job_runs row with type="${jobType}" (no constraint violation)`, async () => {
      const id = randomUUID();
      const payload = SAMPLE_PAYLOADS[jobType] ?? { _dummy: true };
      // Should not throw — if the type is missing from the CHECK constraint,
      // Postgres will raise "ERROR: new row for relation job_runs violates
      // check constraint job_runs_type_check"
      await expect(
        pool.query(
          `INSERT INTO job_runs (id, type, status, payload, attempts, max_attempts)
           VALUES ($1, $2, 'pending', $3, 0, 3)`,
          [id, jobType, JSON.stringify(payload)],
        ),
      ).resolves.toBeDefined();
    });
  }

  it("ALL_JOB_TYPES matches the JobType union (compile-time check via satisfies)", () => {
    // The `satisfies readonly JobType[]` in job-types.ts ensures this at compile time.
    // This runtime check verifies the list is non-empty and all entries are strings.
    expect(ALL_JOB_TYPES.length).toBeGreaterThan(0);
    for (const t of ALL_JOB_TYPES) {
      expect(typeof t).toBe("string");
    }
  });
});
