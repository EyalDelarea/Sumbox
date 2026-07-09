import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";
import type { Job, JobType } from "../jobs/job-types.js";

/**
 * T3 fair-share dispatcher.
 *
 * The inference pipeline is a single slot (one resident model, CPU-bound), and jobs
 * arrive on shared FIFO queues — so N queued jobs from tenant A would starve tenant B
 * for the whole backlog. This dispatcher sits between the bus and the real handler:
 * delivered-but-not-yet-run jobs wait in a per-tenant lane, and the single executor
 * picks lanes ROUND-ROBIN (per-tenant FIFO within a lane).
 *
 * Fairness bound: once a tenant's job has been delivered, at most (#active tenants − 1)
 * other jobs run before it — regardless of how deep another tenant's backlog is.
 * The visible window equals the consumer prefetch: raise prefetch (fairShareWindow in
 * buildWorker) so the dispatcher can actually see competing tenants' jobs.
 *
 * Ack semantics are preserved: the promise returned for a job settles when THAT job
 * finishes (or fails), so the bus acks/retries exactly as before.
 */
export function makeFairShareDispatcher<T extends JobType>(
  handler: (job: Job<T>) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  type Pending = { job: Job<T>; resolve: () => void; reject: (err: unknown) => void };

  const lanes = new Map<string, Pending[]>(); // tenantId → FIFO of waiting jobs
  const ring: string[] = []; // round-robin order over tenant ids (grow-only)
  let ringIdx = 0;
  let running = false;

  const nextPending = (): Pending | null => {
    for (let i = 0; i < ring.length; i++) {
      const idx = (ringIdx + i) % ring.length;
      const lane = lanes.get(ring[idx] as string) as Pending[];
      if (lane.length > 0) {
        ringIdx = (idx + 1) % ring.length;
        return lane.shift() as Pending;
      }
    }
    return null;
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const next = nextPending();
        if (!next) break;
        try {
          await handler(next.job);
          next.resolve();
        } catch (err) {
          // The failure belongs to THIS job's delivery (bus retries it); the lane
          // itself keeps draining.
          next.reject(err);
        }
      }
    } finally {
      running = false;
    }
  };

  return (job: Job<T>): Promise<void> => {
    const payload = job.payload as { tenantId?: string };
    const tenantId = payload.tenantId ?? DEFAULT_TENANT_ID;
    let lane = lanes.get(tenantId);
    if (!lane) {
      lane = [];
      lanes.set(tenantId, lane);
      ring.push(tenantId);
    }
    return new Promise<void>((resolve, reject) => {
      (lane as Pending[]).push({ job, resolve, reject });
      void pump();
    });
  };
}
