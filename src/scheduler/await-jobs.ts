/**
 * awaitJobsSettled — wait, bounded, until a set of jobs has finished.
 *
 * WHY. The digest run enqueues one summarize.group per changed group and then
 * one summarize.total. They sit on separate queues, and the worker's single
 * Ollama slot is FIFO across types: the first group job takes the slot, the
 * total is delivered at once and queues behind it, and the next group job
 * (prefetch 1) is only delivered after the first acks — so it lands BEHIND the
 * total. Observed 2026-11-12 and 2026-11-16, including serve's catch-up of a
 * missed slot: the total started alongside the groups, finished first, and
 * missed the fresh group summaries. The scheduler now holds the total back
 * until this run's group jobs have settled.
 *
 * WHY HERE AND NOT IN THE TOTAL HANDLER. Waiting inside the summarize.total
 * handler would hold the Ollama slot the group jobs need (deadlock until the
 * timeout), and hold an unacked message long enough to trip RabbitMQ's
 * consumer_timeout, which closes the channel every consumer in the worker
 * shares. The scheduler lives in serve, so its wait blocks no worker at all.
 *
 * "SETTLED" means done or dead. `failed` is NOT settled: the bus only writes
 * failed when it has republished a retry (an exhausted job becomes dead). A row
 * that doesn't exist counts as settled — the bus writes the row before it
 * publishes, so there is nothing to wait for.
 *
 * BOUNDED. A job whose message was lost stays pending forever, so the wait
 * gives up at `timeoutMs` and the caller proceeds anyway. A failing status read
 * is retried on the next poll, under the same deadline.
 */

import type { JobStatus } from "../db/repositories/job-runs.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type AwaitJobsDeps = {
  getStatuses: (ids: readonly string[]) => Promise<Map<string, JobStatus>>;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** Reports a failed status read (the wait continues). */
  onPollError?: (err: unknown) => void;
};

export type AwaitJobsOptions = {
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
};

export type AwaitJobsOutcome =
  | { status: "settled" }
  | { status: "timeout"; unsettled: string[] }
  | { status: "aborted"; unsettled: string[] };

/** Two hours: far beyond a normal run, far below the twelve-hour slot spacing. */
export const DEFAULT_GROUP_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_GROUP_WAIT_POLL_MS = 15_000;

const SETTLED: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "dead"]);

// ── Wait ────────────────────────────────────────────────────────────────────

export async function awaitJobsSettled(
  deps: AwaitJobsDeps,
  ids: readonly string[],
  opts: AwaitJobsOptions,
): Promise<AwaitJobsOutcome> {
  let unsettled = [...ids];
  const deadline = deps.now() + opts.timeoutMs;

  for (;;) {
    if (opts.signal?.aborted) return { status: "aborted", unsettled };
    if (unsettled.length === 0) return { status: "settled" };

    try {
      const statuses = await deps.getStatuses(unsettled);
      unsettled = unsettled.filter((id) => {
        const s = statuses.get(id);
        return s !== undefined && !SETTLED.has(s);
      });
    } catch (err) {
      deps.onPollError?.(err);
    }
    if (unsettled.length === 0) return { status: "settled" };

    const remaining = deadline - deps.now();
    if (remaining <= 0) return { status: "timeout", unsettled };
    await deps.sleep(Math.min(opts.pollMs, remaining), opts.signal);
  }
}

/**
 * Production sleep: abort-aware, and unref'd so a pending wait never holds a
 * shutting-down process open.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
