export type JobType =
  | "import.file"
  | "transcribe.voicenote"
  | "analyze.image"
  | "analyze.video"
  | "summarize.group"
  | "summarize.total";

/**
 * Single source of truth for all valid job types at runtime.
 * IMPORTANT: when adding a new JobType to the union above, you MUST also:
 *   1. Add it here (the `satisfies` ensures compile-time sync with the union)
 *   2. Add a migration that widens the job_runs_type_check Postgres constraint
 * The test src/jobs/job-runs-constraint.test.ts will catch forgotten migrations.
 */
export const ALL_JOB_TYPES = [
  "import.file",
  "transcribe.voicenote",
  "analyze.image",
  "analyze.video",
  "summarize.group",
  "summarize.total",
] as const satisfies readonly JobType[];

/**
 * Every payload carries the tenant the job belongs to (T2). Producers stamp it from
 * their active tenant context; the worker re-establishes that context around the
 * handler. OPTIONAL for rolling-upgrade compatibility: jobs enqueued before T2 have no
 * tenantId and are processed as the default tenant — exactly what they were.
 */
type TenantStamped = { tenantId?: string };

export interface JobPayloads {
  "import.file": TenantStamped & { filePath: string; name?: string };
  "transcribe.voicenote": TenantStamped & { messageId: string };
  "analyze.image": TenantStamped & { messageId: string };
  "analyze.video": TenantStamped & { messageId: string };
  "summarize.group": TenantStamped & { groupId: string };
  "summarize.total": TenantStamped & { since: string };
}

export interface Job<T extends JobType = JobType> {
  id: string;
  type: T;
  payload: JobPayloads[T];
  attempts: number;
  maxAttempts: number;
}

export interface ConsumeOptions {
  prefetch: number;
}
