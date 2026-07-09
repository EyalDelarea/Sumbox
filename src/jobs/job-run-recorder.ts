import type pg from "pg";
import type { JobStatus } from "../db/repositories/job-runs.js";
import { setJobStatus, upsertJobRun } from "../db/repositories/job-runs.js";
import type { Job, JobType } from "./job-types.js";

/** Seam: records job lifecycle events; decouples the bus from the database. */
export interface JobRunRecorder {
  recordEnqueued(job: Job, maxAttempts: number): Promise<void>;
  recordStatus(id: string, status: JobStatus, lastError?: string): Promise<void>;
}

/** Production implementation backed by Postgres via job-runs repository. */
export class PostgresJobRunRecorder implements JobRunRecorder {
  constructor(private readonly client: pg.Pool | pg.PoolClient) {}

  async recordEnqueued(job: Job, maxAttempts: number): Promise<void> {
    await upsertJobRun(this.client, {
      id: job.id,
      type: job.type as JobType,
      status: "pending",
      payload: job.payload as Record<string, unknown>,
      attempts: job.attempts,
      maxAttempts,
    });
  }

  async recordStatus(id: string, status: JobStatus, lastError?: string): Promise<void> {
    await setJobStatus(this.client, id, status, lastError);
  }
}

export interface RecordedEntry {
  id: string;
  status: JobStatus;
  lastError?: string;
}

/** In-memory implementation for unit tests — no database required. */
export class InMemoryJobRunRecorder implements JobRunRecorder {
  private readonly _enqueuedJobs: Array<{ job: Job; maxAttempts: number }> = [];
  private readonly _statusHistory: RecordedEntry[] = [];

  async recordEnqueued(job: Job, maxAttempts: number): Promise<void> {
    this._enqueuedJobs.push({ job, maxAttempts });
    this._statusHistory.push({ id: job.id, status: "pending" });
  }

  async recordStatus(id: string, status: JobStatus, lastError?: string): Promise<void> {
    this._statusHistory.push({ id, status, lastError });
  }

  /** All status transitions recorded, in order. */
  get statusHistory(): ReadonlyArray<RecordedEntry> {
    return this._statusHistory;
  }

  /** All enqueued jobs. */
  get enqueuedJobs(): ReadonlyArray<{ job: Job; maxAttempts: number }> {
    return this._enqueuedJobs;
  }

  /** Status history filtered by job id. */
  historyFor(id: string): RecordedEntry[] {
    return this._statusHistory.filter((e) => e.id === id);
  }
}
