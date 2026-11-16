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
 * Rows are read before the queue is inspected, so a job published wholly between
 * the two reads only makes us under-count (re-sent on a later restart). But the
 * bus writes the row BEFORE it publishes the message, so a concurrent publish
 * whose row lands before our read and whose message lands after the queue check
 * over-counts by one and double-sends the oldest, still-queued row. Handlers are
 * idempotent, so that duplicate is a no-op. The grace window keeps us from
 * re-sending a row created moments ago.
 *
 * WHAT IT RE-SENDS. Only types that this worker consumes AND that opt in via
 * JOB_DESCRIPTORS[type].requeueOnStartup (verified-idempotent handlers). The
 * message keeps the row's id and starts at attempts 0; no row is written.
 *
 * RETIRE INSTEAD OF RE-SEND. Types that opt in via
 * JOB_DESCRIPTORS[type].retireOrphansOnStartup (the summaries) are counted the
 * same way, but their orphans are not re-sent: a lost summary is superseded by
 * the next scheduled run, and a lost total by the next run's window. Left alone
 * they sit `pending` forever (36 summarize.group rows from 2026-07..09 did).
 * Orphaned `pending` rows older than RETIRE_MIN_AGE_MS are retired: marked
 * `dead` with the RETIRED_ORPHAN_ERROR marker (retirePendingJobRuns) — a status
 * update, never a delete. `dead` so every reader sees the row as settled; the
 * marker so ops-sweep's redrive skips it instead of replaying and deleting it.
 *
 * Retirement counts ONLY `pending` rows against the queue: missing =
 * pending rows − ready messages. Ready messages also include genuine `failed`
 * retries, so the count can come out LOW (an orphan waits for a later startup),
 * never high.
 *
 * WHICH rows is a guess: like the re-send path, it takes the OLDEST `missing`
 * rows, assuming a broker loss takes the older messages. If instead a newer
 * message was lost while an older backlog row (> RETIRE_MIN_AGE_MS) is still
 * queued, the older, still-queued row is retired. That self-heals: when its
 * message is consumed the bus sets the row `running` unconditionally and it
 * settles normally (covered by a job-runs test); the newer lost row is retired
 * on a later startup. The day-long minimum age keeps every row from the current
 * scheduler run out of reach.
 */
import type { NonTerminalJobRun } from "../db/repositories/job-runs.js";
import { JOB_DESCRIPTORS, type Job, type JobType } from "../jobs/job-types.js";
import type { Logger } from "../logging/logger.js";

// ── Policy ───────────────────────────────────────────────────────────────────

/** Orphans younger than this are never retired — only clearly abandoned rows. */
export const RETIRE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Retire the given still-`pending` rows (dead + RETIRED_ORPHAN_ERROR); returns
   * how many changed (see retirePendingJobRuns).
   */
  retire: (ids: string[]) => Promise<number>;
  log: Pick<Logger, "info" | "warn" | "error">;
};

export type RequeueOutcome =
  | { type: JobType; status: "requeued"; tracked: number; queued: number; requeued: number }
  | { type: JobType; status: "retired"; tracked: number; queued: number; retired: number }
  | { type: JobType; status: "skipped-live-consumer"; consumers: number }
  | { type: JobType; status: "error"; error: string; requeued: number };

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
  const eligible = deps.types.filter(
    (t) => JOB_DESCRIPTORS[t].requeueOnStartup || JOB_DESCRIPTORS[t].retireOrphansOnStartup,
  );
  const outcomes: RequeueOutcome[] = [];

  for (const type of eligible) {
    // Counted outside the try so a mid-loop failure still reports what was sent.
    let sent = 0;
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

      if (JOB_DESCRIPTORS[type].retireOrphansOnStartup) {
        const cutoff = new Date(deps.now().getTime() - Math.max(deps.graceMs, RETIRE_MIN_AGE_MS));
        // Pending rows only, counted against the whole queue — see the header
        // for why this can under-count, and what happens if it picks wrong.
        const pending = rows.filter((r) => r.status === "pending");
        const ids = selectOrphans(pending, ready, cutoff).map((r) => r.id);
        const retired = await deps.retire(ids);
        const line = `Retired ${retired} orphaned ${type} job(s) on startup as dead (${rows.length} open in job_runs, ${ready} in queue).`;
        const fields = { jobType: type, retired, tracked: rows.length, queued: ready };
        if (retired > 0) deps.log.warn(fields, line);
        else deps.log.info(fields, line);
        outcomes.push({ type, status: "retired", tracked: rows.length, queued: ready, retired });
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
        sent++;
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
      deps.log.error(
        { err, jobType: type, requeued: sent },
        `Startup requeue failed for ${type} after re-sending ${sent} job(s): ${error}`,
      );
      outcomes.push({ type, status: "error", error, requeued: sent });
    }
  }

  return outcomes;
}
