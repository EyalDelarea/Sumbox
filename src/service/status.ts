import type pg from "pg";
import { countJobsByStatus } from "../db/repositories/job-runs.js";
import { getServiceStatus, isStale } from "../db/repositories/service-status.js";
import type { JobType } from "../jobs/job-types.js";

/** Default staleness threshold: a service heartbeat older than 5 minutes is considered stale. */
export const DEFAULT_STALENESS_MS = 5 * 60 * 1_000;

export type QueueDepthEntry = { depth: number | null };

export type StatusReport = {
  service: {
    up: boolean;
    collectorConnected: boolean;
    lastHeartbeatAt: string | null;
    lastQrAt: string | null;
    stale: boolean;
  };
  queues: Partial<Record<JobType, QueueDepthEntry>>;
  jobs: {
    pending: number;
    running: number;
    done: number;
    failed: number;
    dead: number;
  };
  generatedAt: string;
};

export type StatusDeps = {
  pool: pg.Pool;
  getQueueDepths: () => Promise<Partial<Record<JobType, number>>>;
  stalenessMs: number;
};

/**
 * Build a status report. Reads service_status + job counts from DB (throws on
 * DB failure — the caller maps that to 503). Queue depths are best-effort:
 * if getQueueDepths throws or a type is missing, depth is null (FR-019).
 */
export async function buildStatusReport(deps: StatusDeps): Promise<StatusReport> {
  const { pool, getQueueDepths, stalenessMs } = deps;

  // DB reads — let exceptions propagate (route catches → 503)
  const [serviceRow, jobCounts] = await Promise.all([
    getServiceStatus(pool),
    countJobsByStatus(pool),
  ]);

  const stale = serviceRow === null ? true : isStale(serviceRow, stalenessMs);
  const up = serviceRow !== null && !stale;

  // Queue depths — best-effort, never fail the report
  let rawDepths: Partial<Record<JobType, number>> = {};
  try {
    rawDepths = await getQueueDepths();
  } catch {
    // broker unreachable — all depths will be null
  }

  const allTypes: JobType[] = ["import.file", "transcribe.voicenote"];
  const queues: Partial<Record<JobType, QueueDepthEntry>> = {};
  for (const type of allTypes) {
    const raw = rawDepths[type];
    queues[type] = { depth: raw !== undefined ? raw : null };
  }

  return {
    service: {
      up,
      collectorConnected: serviceRow?.collector_connected ?? false,
      lastHeartbeatAt: serviceRow?.last_heartbeat_at?.toISOString() ?? null,
      lastQrAt: serviceRow?.last_qr_at?.toISOString() ?? null,
      stale,
    },
    queues,
    jobs: {
      pending: jobCounts["pending"] ?? 0,
      running: jobCounts["running"] ?? 0,
      done: jobCounts["done"] ?? 0,
      failed: jobCounts["failed"] ?? 0,
      dead: jobCounts["dead"] ?? 0,
    },
    generatedAt: new Date().toISOString(),
  };
}
