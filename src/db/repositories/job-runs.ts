import type pg from "pg";
import type { JobType } from "../../jobs/job-types.js";

export type JobStatus = "pending" | "running" | "done" | "failed" | "dead";
export type { JobType };

export type UpsertJobRunInput = {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
};

/** Upsert a job_runs row by id. On conflict, updates all mutable fields and touches updated_at. */
export async function upsertJobRun(
  client: pg.Pool | pg.PoolClient,
  input: UpsertJobRunInput,
): Promise<void> {
  await client.query(
    `
    INSERT INTO job_runs (id, type, status, payload, attempts, max_attempts, last_error, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now())
    ON CONFLICT (id) DO UPDATE SET
      type         = EXCLUDED.type,
      status       = EXCLUDED.status,
      payload      = EXCLUDED.payload,
      attempts     = EXCLUDED.attempts,
      max_attempts = EXCLUDED.max_attempts,
      last_error   = EXCLUDED.last_error,
      updated_at   = now()
    `,
    [
      input.id,
      input.type,
      input.status,
      JSON.stringify(input.payload),
      input.attempts,
      input.maxAttempts,
      input.lastError ?? null,
    ],
  );
}

/**
 * Update status (and optionally last_error) for a job; touches updated_at.
 * On each transition into 'running' we (re)stamp started_at = now(), which
 * lets us split queue wait (started_at - created_at) from processing time
 * (updated_at - started_at). Re-stamping on retries means processing time
 * reflects the attempt that actually ran, not the inter-retry gap.
 */
export async function setJobStatus(
  client: pg.Pool | pg.PoolClient,
  id: string,
  status: JobStatus,
  lastError?: string,
): Promise<void> {
  await client.query(
    `
    UPDATE job_runs
    SET status     = $2,
        last_error = COALESCE($3, last_error),
        started_at = CASE WHEN $2 = 'running' THEN now() ELSE started_at END,
        updated_at = now()
    WHERE id = $1
    `,
    [id, status, lastError ?? null],
  );
}

/**
 * On worker startup, reset any orphaned 'running' rows to 'failed'.
 * These are jobs that were in-flight when the previous worker process was
 * killed (e.g. OOM, SIGKILL). Without this reset they block dashboards and
 * analytics indefinitely.
 *
 * Returns the number of rows updated.
 */
export async function resetStaleRunningJobs(client: pg.Pool | pg.PoolClient): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE job_runs
     SET status     = 'failed',
         last_error = 'worker restarted',
         updated_at = now()
     WHERE status = 'running'`,
  );
  return rowCount ?? 0;
}

/**
 * Count job_runs rows that are currently in-flight (pending or running) for
 * media-analysis types (analyze.image, analyze.video, transcribe.voicenote).
 * Used by the summarize SSE handler to surface how many Ollama jobs are ahead
 * of the summary in the queue.
 */
export async function countInFlightMediaJobs(client: pg.Pool | pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT count(*) AS cnt
     FROM job_runs
     WHERE status IN ('pending', 'running')
       AND type IN ('analyze.image', 'analyze.video', 'transcribe.voicenote')`,
  );
  return Number(rows[0].cnt);
}

/** Return a record of status → count for all job_runs rows. Missing statuses return 0. */
export async function countJobsByStatus(
  client: pg.Pool | pg.PoolClient,
): Promise<Record<string, number>> {
  const { rows } = await client.query<{ status: string; cnt: string }>(
    `SELECT status, count(*) AS cnt FROM job_runs GROUP BY status`,
  );

  const result: Record<string, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    dead: 0,
  };

  for (const row of rows) {
    result[row.status] = Number(row.cnt);
  }

  return result;
}
