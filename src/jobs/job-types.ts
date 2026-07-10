/** Per-job-type runtime policy. */
export type JobDescriptor = {
  /**
   * Prefetch policy. "one" caps the consumer at a single un-acked message —
   * backpressure for slow GPU/LLM-bound jobs; "concurrency" uses the worker's
   * `--concurrency`. A wrong value here can silently trip consumer_timeout.
   */
  prefetch: "one" | "concurrency";
  /**
   * True when the job calls Ollama directly (LLM or vision). These share a
   * single serialization gate so they never issue concurrent requests (a
   * model-swap can exceed the socket timeout → RabbitMQ consumer_timeout).
   * `transcribe.voicenote` is false — it uses faster-whisper, not Ollama.
   */
  usesOllama: boolean;
  /** Coarse operation label for metrics/dashboards. */
  opLabel: string;
};

/**
 * Single source of truth for every job type AND its policy — one row per type.
 * The `JobType` union, `ALL_JOB_TYPES`, the worker's prefetch/Ollama gates, and
 * `opForJobType` all derive from this table, so a new type can't silently miss a
 * policy (the `satisfies` forces all three fields on every row).
 *
 * IMPORTANT: adding a row here also needs a migration widening the
 * job_runs_type_check Postgres constraint — the test
 * src/jobs/job-runs-constraint.test.ts fails CI if you forget.
 */
export const JOB_DESCRIPTORS = {
  "import.file": { prefetch: "concurrency", usesOllama: false, opLabel: "import" },
  "transcribe.voicenote": { prefetch: "one", usesOllama: false, opLabel: "audio" },
  "analyze.image": { prefetch: "one", usesOllama: true, opLabel: "image" },
  "analyze.video": { prefetch: "one", usesOllama: true, opLabel: "video" },
  "summarize.group": { prefetch: "one", usesOllama: true, opLabel: "summary" },
  "summarize.total": { prefetch: "one", usesOllama: true, opLabel: "summary" },
} as const satisfies Record<string, JobDescriptor>;

export type JobType = keyof typeof JOB_DESCRIPTORS;

/** All valid job types at runtime, derived from JOB_DESCRIPTORS (never drifts). */
export const ALL_JOB_TYPES = Object.keys(JOB_DESCRIPTORS) as JobType[];

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
