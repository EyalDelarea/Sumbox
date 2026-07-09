import type pg from "pg";

export type FlaggedDetail = {
  type: string;
  messageId: string | undefined;
  redriveCount: number;
  lastError: string | null | undefined;
};

export type StatusSnapshotInput = {
  serviceUp: boolean;
  collectorConnected: boolean;
  lastHeartbeatAt: Date | null;
  stale: boolean;
  jobsPending: number;
  jobsRunning: number;
  jobsDone: number;
  jobsFailed: number;
  jobsDead: number;
  queueDepths: Record<string, number | null> | null;
  redriven: number;
  flagged: number;
  flaggedDetails: FlaggedDetail[];
};

export type StatusSnapshotRow = StatusSnapshotInput & {
  id: string;
  capturedAt: Date;
};

/** Insert a new status snapshot row. Returns the inserted id. */
export async function insertStatusSnapshot(
  client: pg.Pool | pg.PoolClient,
  input: StatusSnapshotInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO status_snapshots (
      service_up,
      collector_connected,
      last_heartbeat_at,
      stale,
      jobs_pending,
      jobs_running,
      jobs_done,
      jobs_failed,
      jobs_dead,
      queue_depths,
      redriven,
      flagged,
      flagged_details
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
    `,
    [
      input.serviceUp,
      input.collectorConnected,
      input.lastHeartbeatAt ?? null,
      input.stale,
      input.jobsPending,
      input.jobsRunning,
      input.jobsDone,
      input.jobsFailed,
      input.jobsDead,
      input.queueDepths !== null ? JSON.stringify(input.queueDepths) : null,
      input.redriven,
      input.flagged,
      JSON.stringify(input.flaggedDetails),
    ],
  );
  return rows[0].id;
}

/** List the most recent status snapshots, newest-first. */
export async function listStatusSnapshots(
  client: pg.Pool | pg.PoolClient,
  limit: number,
): Promise<StatusSnapshotRow[]> {
  const { rows } = await client.query<{
    id: string;
    captured_at: Date;
    service_up: boolean;
    collector_connected: boolean;
    last_heartbeat_at: Date | null;
    stale: boolean;
    jobs_pending: number;
    jobs_running: number;
    jobs_done: number;
    jobs_failed: number;
    jobs_dead: number;
    queue_depths: Record<string, number | null> | null;
    redriven: number;
    flagged: number;
    flagged_details: FlaggedDetail[];
  }>(
    `
    SELECT
      id,
      captured_at,
      service_up,
      collector_connected,
      last_heartbeat_at,
      stale,
      jobs_pending,
      jobs_running,
      jobs_done,
      jobs_failed,
      jobs_dead,
      queue_depths,
      redriven,
      flagged,
      flagged_details
    FROM status_snapshots
    ORDER BY captured_at DESC
    LIMIT $1
    `,
    [limit],
  );

  return rows.map((r) => ({
    id: r.id,
    capturedAt: r.captured_at,
    serviceUp: r.service_up,
    collectorConnected: r.collector_connected,
    lastHeartbeatAt: r.last_heartbeat_at,
    stale: r.stale,
    jobsPending: Number(r.jobs_pending),
    jobsRunning: Number(r.jobs_running),
    jobsDone: Number(r.jobs_done),
    jobsFailed: Number(r.jobs_failed),
    jobsDead: Number(r.jobs_dead),
    queueDepths: r.queue_depths,
    redriven: Number(r.redriven),
    flagged: Number(r.flagged),
    flaggedDetails: r.flagged_details ?? [],
  }));
}
