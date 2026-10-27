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
  /**
   * True when the worker may re-send this type's lost messages at startup
   * (src/workers/requeue-orphans.ts). Only for types whose handler is verified
   * idempotent AND whose work is still worth doing however late it runs: a
   * re-sent job may be months old.
   */
  requeueOnStartup: boolean;
};

/**
 * Single source of truth for every job type AND its policy — one row per type.
 * The `JobType` union, `ALL_JOB_TYPES`, the worker's prefetch/Ollama gates, and
 * `opForJobType` all derive from this table, so a new type can't silently miss a
 * policy (the `satisfies` forces every field on every row).
 *
 * IMPORTANT: adding a row here also needs a migration widening the
 * job_runs_type_check Postgres constraint — the test
 * src/jobs/job-runs-constraint.test.ts fails CI if you forget.
 */
export const JOB_DESCRIPTORS = {
  // Not requeued on startup: the export file it points at is often gone by then.
  "import.file": {
    prefetch: "concurrency",
    usesOllama: false,
    opLabel: "import",
    requeueOnStartup: false,
  },
  // The three media types ARE requeued on startup: makeIdempotentHandler skips a
  // message that already has a transcript/analysis, and enrichment never goes stale.
  "transcribe.voicenote": {
    prefetch: "one",
    usesOllama: false,
    opLabel: "audio",
    requeueOnStartup: true,
  },
  "analyze.image": { prefetch: "one", usesOllama: true, opLabel: "image", requeueOnStartup: true },
  "analyze.video": { prefetch: "one", usesOllama: true, opLabel: "video", requeueOnStartup: true },
  // Not requeued: the scheduler re-enqueues every changed group on each run, so a
  // lost summary is already superseded; replaying it is a stale LLM run.
  "summarize.group": {
    prefetch: "one",
    usesOllama: true,
    opLabel: "summary",
    requeueOnStartup: false,
  },
  // Not requeued: not idempotent — every run inserts a new total_summaries row.
  "summarize.total": {
    prefetch: "one",
    usesOllama: true,
    opLabel: "summary",
    requeueOnStartup: false,
  },
  // @Aida's memory extraction. Ollama-bound like the summarizer, and prefetch
  // "one" for the same reason: it shares the single local GPU, and a shadow-phase
  // background job must never starve a summary or an answer someone is waiting on.
  // Not requeued: shadow-phase output nothing reads yet — not worth replaying.
  "memory.extract": {
    prefetch: "one",
    usesOllama: true,
    opLabel: "summary",
    requeueOnStartup: false,
  },
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
  /** The window is explicit so a re-run over the same span converges — the
   *  observation dedupe key makes re-extraction idempotent. */
  "memory.extract": { groupId: string; since: string; until: string };
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
