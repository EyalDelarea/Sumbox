/**
 * Startup requeue — restore job messages the broker lost.
 *
 * The bus writes a `pending` job_runs row and then publishes a message; nothing
 * else ever re-publishes from the database. So when RabbitMQ loses its queue
 * contents (a container recreate, a wiped volume), those rows stay `pending`
 * forever with no message behind them, and the work silently never happens.
 *
 * WHY BY COUNT, NOT BY AGE. "Pending for more than N minutes" is not a sign of
 * a lost message: a slow vision backlog keeps hundreds of rows pending for hours
 * while their messages sit safely in the queue, and re-sending all of them on
 * every restart would duplicate the whole backlog. Instead we use the invariant
 * that, in a healthy system, every non-terminal row (pending / running / failed —
 * see listNonTerminalJobRuns) has exactly one message in `jobs.<type>`. So:
 *
 *     lost = (non-terminal rows) − (ready messages in the queue)
 *
 * and we re-send that many rows, oldest first: messages published after the
 * loss are still queued, so the lost ones are the oldest. Re-running converges —
 * each re-sent message raises the queue count, so a second pass finds 0 lost.
 *
 * WHEN IT IS SAFE. `ready` excludes messages a live consumer holds unacked, so
 * the count is only right while nobody is consuming the type:
 *   - this runs in the worker BEFORE buildWorker attaches its consumers, and after
 *     resetStaleRunningJobs (a dead worker's unacked messages are back to ready);
 *   - a type that already has a consumer (another worker process) is skipped.
 * Rows are read before the queue is inspected, so a job the collector publishes
 * in between can only make us under-count (re-sent on a later restart), never
 * double-send. The grace window keeps us from touching a row created moments ago.
 *
 * WHAT IT RE-SENDS. Only types that this worker consumes AND that opt in via
 * JOB_DESCRIPTORS[type].requeueOnStartup (verified-idempotent handlers). The
 * message keeps the row's id and starts at attempts 0; no row is written.
 */
import type { NonTerminalJobRun } from "../db/repositories/job-runs.js";
import { JOB_DESCRIPTORS, type Job, type JobType } from "../jobs/job-types.js";
import type { Logger } from "../logging/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** The broker half of the requeue (implemented by RabbitMqJobBus). */
export interface RequeueBus {
  queueStats(type: JobType): Promise<{ ready: number; consumers: number }>;
  republish(job: Job): Promise<void>;
}

export type RequeueOrphansDeps = {
  /** Job types this worker is about to consume. */
  types: readonly JobType[];
  listNonTerminal: (type: JobType) => Promise<NonTerminalJobRun[]>;
  bus: RequeueBus;
  now: () => Date;
  /** Rows younger than this are never re-sent. */
  graceMs: number;
  log: Pick<Logger, "info" | "warn" | "error">;
};

export type RequeueOutcome =
  | { type: JobType; status: "requeued"; tracked: number; queued: number; requeued: number }
  | { type: JobType; status: "skipped-live-consumer"; consumers: number }
  | { type: JobType; status: "error"; error: string };

/** Default grace window: 5 minutes. */
export const DEFAULT_REQUEUE_GRACE_MS = 5 * 60 * 1000;

// ── Selection (pure) ─────────────────────────────────────────────────────────

/**
 * Pick the rows whose messages are missing. `rows` must be oldest first.
 * Returns the oldest `rows.length − queued` rows, minus any created after
 * `cutoff` (still inside the grace window).
 */
export function selectOrphans(
  rows: readonly NonTerminalJobRun[],
  queued: number,
  cutoff: Date,
): NonTerminalJobRun[] {
  const missing = rows.length - queued;
  if (missing <= 0) return [];
  return rows.slice(0, missing).filter((r) => r.createdAt.getTime() <= cutoff.getTime());
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Re-send lost messages for every eligible type and log one line per type.
 * A failure on one type is logged and does not stop the others or the worker:
 * this is recovery, and the worker must still come up to process what IS queued.
 */
export async function requeueOrphanedJobs(deps: RequeueOrphansDeps): Promise<RequeueOutcome[]> {
  const eligible = deps.types.filter((t) => JOB_DESCRIPTORS[t].requeueOnStartup);
  const outcomes: RequeueOutcome[] = [];

  for (const type of eligible) {
    try {
      // Rows BEFORE the queue — see the header for why the order matters.
      const rows = await deps.listNonTerminal(type);
      const { ready, consumers } = await deps.bus.queueStats(type);

      if (consumers > 0) {
        deps.log.warn(
          { jobType: type, consumers },
          `Startup requeue skipped for ${type}: ${consumers} consumer(s) already attached, so lost messages can't be counted.`,
        );
        outcomes.push({ type, status: "skipped-live-consumer", consumers });
        continue;
      }

      const cutoff = new Date(deps.now().getTime() - deps.graceMs);
      const orphans = selectOrphans(rows, ready, cutoff);
      for (const row of orphans) {
        await deps.bus.republish({
          id: row.id,
          type,
          payload: row.payload as Job["payload"],
          attempts: 0,
          maxAttempts: row.maxAttempts,
        });
      }

      deps.log.info(
        { jobType: type, requeued: orphans.length, tracked: rows.length, queued: ready },
        `Re-queued ${orphans.length} orphaned ${type} job(s) on startup (${rows.length} open in job_runs, ${ready} in queue).`,
      );
      outcomes.push({
        type,
        status: "requeued",
        tracked: rows.length,
        queued: ready,
        requeued: orphans.length,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log.error({ err, jobType: type }, `Startup requeue failed for ${type}: ${error}`);
      outcomes.push({ type, status: "error", error });
    }
  }

  return outcomes;
}
