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

export interface JobPayloads {
  "import.file": { filePath: string; name?: string };
  "transcribe.voicenote": { messageId: string };
  "analyze.image": { messageId: string };
  "analyze.video": { messageId: string };
  "summarize.group": { groupId: string };
  "summarize.total": { since: string };
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
