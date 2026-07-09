export type { ConsumeOptions, Job, JobPayloads, JobType } from "./job-types.js";

import type { ConsumeOptions, Job, JobPayloads, JobType } from "./job-types.js";

export interface JobBus {
  /** Publish a job. Generates id if absent; records a 'pending' job_runs row. */
  enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[T],
    opts?: { maxAttempts?: number },
  ): Promise<{ id: string }>;

  /** Register a consumer. handler resolves → ack; throws → nack/retry or DLQ when attempts exhausted. */
  consume<T extends JobType>(
    type: T,
    handler: (job: Job<T>) => Promise<void>,
    opts: ConsumeOptions,
  ): Promise<void>;

  /** Current depth of a job type's main queue (best-effort; for status). */
  depth(type: JobType): Promise<number>;

  /** Graceful shutdown: stop consuming, drain in-flight acks, close channel/connection. */
  close(): Promise<void>;
}
