import type pg from "pg";
import {
  insertStatusSnapshot,
  type StatusSnapshotRow,
} from "../db/repositories/status-snapshots.js";
import type { JobBus } from "../jobs/job-bus.js";
import type { JobType } from "../jobs/job-types.js";
import { buildStatusReport, type StatusDeps } from "../service/status.js";
import { type FlaggedDetail, redriveDeadJobs } from "./redrive.js";

export type RunOpsSweepOpts = {
  pool: pg.Pool;
  bus: JobBus;
  getQueueDepths: () => Promise<Partial<Record<JobType, number>>>;
  stalenessMs: number;
  /** Max re-drives per work-item before flagging. Default 2. */
  cap: number;
  /** Optional pino-compatible logger. */
  logger?: { info(obj: Record<string, unknown>): void } | undefined;
  now: () => Date;
};

/**
 * Orchestrate one ops sweep:
 * 1. Re-drive dead jobs (redriveDeadJobs).
 * 2. Build status report (buildStatusReport).
 * 3. Insert status snapshot combining both.
 * 4. Log one structured line.
 *
 * NEVER throws — sub-step failures are caught and recorded as a partial
 * snapshot so the sweep always produces a DB row.
 */
export async function runOpsSweep(opts: RunOpsSweepOpts): Promise<StatusSnapshotRow> {
  const { pool, bus, getQueueDepths, stalenessMs, cap, logger, now } = opts;

  // Step 1: re-drive dead jobs (best-effort)
  let redriven = 0;
  let flagged = 0;
  let flaggedDetails: FlaggedDetail[] = [];
  try {
    const redriveResult = await redriveDeadJobs({ pool, bus, cap, now });
    redriven = redriveResult.redriven;
    flagged = redriveResult.flagged;
    flaggedDetails = redriveResult.flaggedDetails;
  } catch (err) {
    logger?.info({
      msg: "ops-sweep: redriveDeadJobs failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2: build status report (best-effort for queue depths)
  const statusDeps: StatusDeps = { pool, getQueueDepths, stalenessMs };
  let statusReport: Awaited<ReturnType<typeof buildStatusReport>> | undefined;
  try {
    statusReport = await buildStatusReport(statusDeps);
  } catch (err) {
    logger?.info({
      msg: "ops-sweep: buildStatusReport failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Build snapshot input from whatever we have
  const snapshotInput = {
    serviceUp: statusReport?.service.up ?? false,
    collectorConnected: statusReport?.service.collectorConnected ?? false,
    lastHeartbeatAt: statusReport?.service.lastHeartbeatAt
      ? new Date(statusReport.service.lastHeartbeatAt)
      : null,
    stale: statusReport?.service.stale ?? true,
    jobsPending: statusReport?.jobs.pending ?? 0,
    jobsRunning: statusReport?.jobs.running ?? 0,
    jobsDone: statusReport?.jobs.done ?? 0,
    jobsFailed: statusReport?.jobs.failed ?? 0,
    jobsDead: statusReport?.jobs.dead ?? 0,
    queueDepths: statusReport
      ? (Object.fromEntries(
          Object.entries(statusReport.queues).map(([k, v]) => [k, v?.depth ?? null]),
        ) as Record<string, number | null>)
      : null,
    redriven,
    flagged,
    flaggedDetails,
  };

  // Step 3: insert snapshot
  const id = await insertStatusSnapshot(pool, snapshotInput);

  // Step 4: one structured log line
  logger?.info({
    msg: "ops-sweep complete",
    snapshotId: id,
    redriven,
    flagged,
    serviceUp: snapshotInput.serviceUp,
    collectorConnected: snapshotInput.collectorConnected,
    jobsDead: snapshotInput.jobsDead,
  });

  return {
    id,
    capturedAt: now(),
    ...snapshotInput,
  };
}
