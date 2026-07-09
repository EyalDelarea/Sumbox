import { randomUUID } from "node:crypto";
import type { JobBus } from "./job-bus.js";
import type { JobRunRecorder } from "./job-run-recorder.js";
import type { ConsumeOptions, Job, JobPayloads, JobType } from "./job-types.js";

const DEFAULT_MAX_ATTEMPTS = 3;

interface QueuedJob<T extends JobType = JobType> {
  job: Job<T>;
  maxAttempts: number;
}

export class InMemoryJobBus implements JobBus {
  private readonly queues = new Map<JobType, Array<QueuedJob>>();
  private readonly dlq = new Map<JobType, Array<Job>>();
  private readonly recorder: JobRunRecorder;
  private readonly idGenerator: () => string;

  constructor(recorder: JobRunRecorder, idGenerator: () => string = randomUUID) {
    this.recorder = recorder;
    this.idGenerator = idGenerator;
  }

  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[T],
    opts?: { maxAttempts?: number },
  ): Promise<{ id: string }> {
    const id = this.idGenerator();
    const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    const job: Job<T> = {
      id,
      type,
      payload,
      attempts: 0,
      maxAttempts,
    };

    await this.recorder.recordEnqueued(job, maxAttempts);

    const queue = this.getQueue(type);
    queue.push({ job, maxAttempts } as QueuedJob);

    return { id };
  }

  async consume<T extends JobType>(
    type: T,
    handler: (job: Job<T>) => Promise<void>,
    _opts: ConsumeOptions,
  ): Promise<void> {
    const queue = this.getQueue(type);

    // Process all currently queued items, handling retries inline.
    // We collect the initial snapshot then process; retries are re-enqueued
    // at the back of the same queue so we keep looping until the queue is empty.
    while (queue.length > 0) {
      const item = queue.shift() as QueuedJob<T>;
      const { maxAttempts } = item;

      // Build the delivery-copy of the job with incremented attempts
      const deliveryJob: Job<T> = {
        ...item.job,
        attempts: item.job.attempts + 1,
      };

      await this.recorder.recordStatus(deliveryJob.id, "running");

      try {
        await handler(deliveryJob);
        await this.recorder.recordStatus(deliveryJob.id, "done");
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (deliveryJob.attempts >= maxAttempts) {
          // Exhausted — dead-letter
          await this.recorder.recordStatus(deliveryJob.id, "dead", errorMessage);
          this.getDlq(type).push(deliveryJob);
        } else {
          // Retryable — record failed and re-enqueue
          await this.recorder.recordStatus(deliveryJob.id, "failed", errorMessage);
          queue.push({
            job: deliveryJob,
            maxAttempts,
          } as unknown as QueuedJob);
        }
      }
    }
  }

  async depth(type: JobType): Promise<number> {
    return this.getQueue(type).length;
  }

  async close(): Promise<void> {
    // No-op for in-memory bus
  }

  /** Inspect dead-lettered jobs for a given type (not part of the JobBus interface). */
  deadLetters<T extends JobType>(type: T): ReadonlyArray<Job<T>> {
    return (this.getDlq(type) as Array<Job<T>>).slice();
  }

  private getQueue(type: JobType): Array<QueuedJob> {
    let q = this.queues.get(type);
    if (!q) {
      q = [];
      this.queues.set(type, q);
    }
    return q;
  }

  private getDlq(type: JobType): Array<Job> {
    let q = this.dlq.get(type);
    if (!q) {
      q = [];
      this.dlq.set(type, q);
    }
    return q;
  }
}
