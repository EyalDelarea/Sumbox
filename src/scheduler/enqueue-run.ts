/**
 * T012 — enqueueScheduledRun
 *
 * Lists all groups; for each group that has readable messages after its
 * watermark (i.e. is "changed"), enqueues a summarize.group job.
 * Unchanged groups are skipped. Per-group errors never abort the batch.
 * Never throws.
 */

import type pg from "pg";
import { listIncludedGroupIds } from "../db/repositories/chat-scopes.js";
import { getJobStatuses } from "../db/repositories/job-runs.js";
import type { JobBus } from "../jobs/job-bus.js";
import {
  type AwaitJobsOutcome,
  abortableSleep,
  awaitJobsSettled,
  DEFAULT_GROUP_WAIT_POLL_MS,
  DEFAULT_GROUP_WAIT_TIMEOUT_MS,
} from "./await-jobs.js";

export type EnqueueScheduledRunOpts = {
  /**
   * Also enqueue @Aida's shadow memory extraction for each group.
   * OFF by default: memory is opt-in while it is in shadow, and the scheduler
   * runs on every install whether or not @Aida is enabled.
   */
  extractMemory?: boolean;
  /** When true, enqueue all groups regardless of whether they have new messages. */
  all?: boolean;
  /**
   * When provided, also enqueue ONE summarize.total job for [since, now] — but
   * only once this run's summarize.group jobs have settled (or the wait timed
   * out), so the total reads fresh group summaries. See await-jobs.ts for why
   * the wait lives here. Omitted by callers that only want per-group behaviour
   * (the manual `digest-run`), which then return as soon as groups are enqueued.
   */
  sinceForTotal?: Date;
  /**
   * Aborts the wait for the group jobs (the scheduler's stop()). An aborted wait
   * enqueues NO total — the caller must not record the run as complete, so the
   * next start's catch-up redoes it (group jobs are idempotent).
   */
  signal?: AbortSignal;
  /** Injectable group-job wait (tests). Defaults to polling job_runs. */
  awaitGroupJobs?: (ids: readonly string[], signal?: AbortSignal) => Promise<AwaitJobsOutcome>;
};

export type EnqueueScheduledRunResult = {
  enqueued: number;
  skipped: number;
  /** Only set when a total was requested (sinceForTotal). */
  total?: "enqueued" | "enqueue-failed" | "aborted";
};

/**
 * Check whether a group has at least one readable message after its watermark.
 *
 * Reuses the same content predicate as selectAfterCursor (non-system, non-empty
 * content after joining transcripts + media_analyses) but only checks existence
 * (LIMIT 1) to keep it cheap.
 *
 * When there is no watermark row (never summarized), the group is considered
 * changed iff it has at least one readable message at all.
 */
async function hasNewMessages(pool: pg.Pool, groupId: number): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `
    SELECT m.id
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
    LEFT JOIN read_watermarks rw ON rw.group_id = m.group_id
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND concat_ws(' — ',
            NULLIF(trim(m.text_content), ''),
            NULLIF(trim(a.description), ''),
            NULLIF(trim(t.transcript), '')
          ) <> ''
      AND (
        rw.group_id IS NULL
        OR m.sent_at > rw.watermark_sent_at
        OR (m.sent_at = rw.watermark_sent_at AND m.id > rw.watermark_message_id)
      )
    LIMIT 1
    `,
    [groupId],
  );
  return rows.length > 0;
}

/**
 * Enqueue a summarize.group job for every group that has new messages since
 * its watermark (or for all groups when opts.all is true).
 *
 * Per-group errors are caught and logged — one failure never aborts the batch.
 * The function itself never throws.
 */
/**
 * How far back memory extraction reads. Deliberately WIDER than the twice-daily
 * digest interval: an overlap costs nothing (re-extraction is idempotent via the
 * observation dedupe key), while a gap silently loses conversation forever.
 */
const MEMORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function enqueueScheduledRun(
  pool: pg.Pool,
  bus: JobBus,
  opts?: EnqueueScheduledRunOpts,
): Promise<EnqueueScheduledRunResult> {
  const now = new Date();
  let enqueued = 0;
  let skipped = 0;
  /** This run's summarize.group job ids — what the total waits for. */
  const groupJobIds: string[] = [];

  try {
    // Only included chats are summarized (S4 scope filter, default-OFF): a group
    // is processed only when it has an explicit `included = true` row — an
    // un-scoped chat is skipped. `opts.all` ignores the watermark, NOT the scope
    // — a forced run must not resurrect un-scoped/excluded chats.
    const includedIds = await listIncludedGroupIds(pool);

    for (const groupId of includedIds) {
      try {
        const changed = opts?.all === true || (await hasNewMessages(pool, groupId));
        if (!changed) {
          skipped++;
          continue;
        }

        const { id } = await bus.enqueue("summarize.group", {
          groupId: String(groupId),
        });
        groupJobIds.push(id);
        enqueued++;

        // @Aida's shadow memory rides the same cadence (D1: piggyback the summary
        // run) but as a SEPARATE job — a failing extractor must never be able to
        // fail or retry a summary someone is waiting for.
        //
        // The window is the scheduler's own interval, passed explicitly so a
        // re-run over the same span converges rather than duplicating (the
        // observation dedupe key makes extraction idempotent).
        //
        // Best-effort: memory is a nice-to-have and the summary is not, so a
        // failure here is logged and the batch continues.
        if (opts?.extractMemory === true) {
          try {
            await bus.enqueue("memory.extract", {
              groupId: String(groupId),
              since: new Date(now.getTime() - MEMORY_WINDOW_MS).toISOString(),
              until: now.toISOString(),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[enqueueScheduledRun] group ${groupId} memory.extract enqueue failed: ${msg}\n`,
            );
          }
        }
      } catch (err) {
        // Per-group error: log and continue the batch
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[enqueueScheduledRun] group ${groupId} failed, skipping: ${msg}\n`);
        // Count as skipped so the caller knows something happened
        skipped++;
      }
    }
  } catch (err) {
    // Outer error (e.g. DB unreachable): log but never throw
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[enqueueScheduledRun] fatal error, returning partial result: ${msg}\n`);
  }

  if (!opts?.sinceForTotal) return { enqueued, skipped };

  // Hold the total back until this run's group jobs have settled. Never throws:
  // the default wait reports read errors itself and always ends (settled,
  // timeout, or aborted).
  const awaitGroups =
    opts.awaitGroupJobs ??
    ((ids: readonly string[], signal?: AbortSignal) =>
      awaitJobsSettled(
        {
          getStatuses: (pending) => getJobStatuses(pool, pending),
          sleep: abortableSleep,
          now: () => Date.now(),
          onPollError: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[enqueueScheduledRun] reading group job status failed (will retry): ${msg}\n`,
            );
          },
        },
        ids,
        {
          timeoutMs: DEFAULT_GROUP_WAIT_TIMEOUT_MS,
          pollMs: DEFAULT_GROUP_WAIT_POLL_MS,
          signal,
        },
      ));
  const wait = await awaitGroups(groupJobIds, opts.signal);
  if (wait.status === "aborted") {
    process.stderr.write(
      `[enqueueScheduledRun] stopped while waiting for ${wait.unsettled.length} group job(s); summarize.total NOT enqueued\n`,
    );
    return { enqueued, skipped, total: "aborted" };
  }
  if (wait.status === "timeout") {
    process.stderr.write(
      `[enqueueScheduledRun] ${wait.unsettled.length} group job(s) still unsettled after the wait (${wait.unsettled.join(", ")}); enqueueing summarize.total anyway\n`,
    );
  }

  try {
    await bus.enqueue("summarize.total", {
      since: opts.sinceForTotal.toISOString(),
    });
    return { enqueued, skipped, total: "enqueued" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[enqueueScheduledRun] summarize.total enqueue failed: ${msg}\n`);
    return { enqueued, skipped, total: "enqueue-failed" };
  }
}
