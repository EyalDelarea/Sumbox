import type pg from "pg";
import type { JobBus } from "../jobs/job-bus.js";
import type { JobType } from "../jobs/job-types.js";

export type FlaggedDetail = {
  type: string;
  messageId: string | undefined;
  redriveCount: number;
  lastError: string | null | undefined;
};

export type RedriveResult = {
  redriven: number;
  flagged: number;
  flaggedDetails: FlaggedDetail[];
};

type DeadRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  last_error: string | null;
};

/**
 * Work-item identity: (type, payload.messageId) when messageId is present,
 * else (type, JSON.stringify(payload-without-redriveCount)).
 */
function workItemKey(type: string, payload: Record<string, unknown>): string {
  const messageId = payload.messageId;
  if (typeof messageId === "string") {
    return `${type}::${messageId}`;
  }
  // Stable key from payload, excluding redriveCount (transient field)
  const stablePayload = { ...payload };
  delete stablePayload.redriveCount;
  return `${type}::${JSON.stringify(stablePayload)}`;
}

export type RedriveDeadJobsOpts = {
  pool: pg.Pool;
  bus: JobBus;
  /** Maximum re-drive count before flagging (default 2). */
  cap: number;
  now: () => Date;
};

/**
 * Re-drive dead jobs with a cap per work-item.
 *
 * Algorithm per spec:
 * 1. Load all dead job_runs rows.
 * 2. Group by work-item identity (type + messageId-or-payload).
 * 3. n = max(redriveCount) across the group.
 * 4. If n < cap: DELETE the group's dead rows; re-enqueue with redriveCount = n+1.
 *    Increment `redriven` by 1 per work-item.
 * 5. If n >= cap: leave dead rows; increment `flagged`; record flaggedDetails.
 */
export async function redriveDeadJobs(opts: RedriveDeadJobsOpts): Promise<RedriveResult> {
  const { pool, bus, cap } = opts;

  // Load all dead rows
  const { rows: deadRows } = await pool.query<DeadRow>(
    `SELECT id, type, payload, last_error FROM job_runs WHERE status = 'dead'`,
  );

  if (deadRows.length === 0) {
    return { redriven: 0, flagged: 0, flaggedDetails: [] };
  }

  // Group by work-item key
  const groups = new Map<string, DeadRow[]>();
  for (const row of deadRows) {
    const key = workItemKey(row.type, row.payload);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  let redriven = 0;
  let flagged = 0;
  const flaggedDetails: FlaggedDetail[] = [];

  for (const [, group] of groups) {
    // n = max redriveCount in this group
    const n = group.reduce((max, row) => {
      const rc = row.payload.redriveCount;
      const count = typeof rc === "number" ? rc : 0;
      return Math.max(max, count);
    }, 0);

    // Use the row with the highest redriveCount as the canonical payload
    const canonical = group.reduce((best, row) => {
      const rc = row.payload.redriveCount;
      const count = typeof rc === "number" ? rc : 0;
      const bestRc = best.payload.redriveCount;
      const bestCount = typeof bestRc === "number" ? bestRc : 0;
      return count >= bestCount ? row : best;
    }, group[0]);

    const messageId =
      typeof canonical.payload.messageId === "string" ? canonical.payload.messageId : undefined;

    if (n < cap) {
      // Re-enqueue FIRST — if this throws, the dead rows are left intact for the next sweep.
      const newPayload = { ...canonical.payload, redriveCount: n + 1 };
      await bus.enqueue(canonical.type as JobType, newPayload as never);

      // Delete old dead rows only after enqueue succeeds.
      // A delete failure here is harmless: the next sweep will see the dead row,
      // re-enqueue again (duplicate), and retry the delete.
      const ids = group.map((r) => r.id);
      await pool.query(`DELETE FROM job_runs WHERE id = ANY($1::uuid[])`, [ids]);

      redriven += 1;
    } else {
      // Leave dead rows; record as flagged
      flagged += 1;
      flaggedDetails.push({
        type: canonical.type,
        messageId,
        redriveCount: n,
        lastError: canonical.last_error,
      });
    }
  }

  return { redriven, flagged, flaggedDetails };
}
