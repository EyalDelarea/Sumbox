import type pg from "pg";
import type { JobPayloads, JobType } from "../../jobs/job-types.js";
import type { StreamingSummarizer } from "../../summarization/summarizer.js";
import type { OnboardingRegistry } from "../onboarding-routes.js";

/** Sumbox-mode fallback window when a group has no read watermark yet. */
export const SUMBOX_FALLBACK_N = 25;

/**
 * Everything a request handler needs. Defined here (not in server.ts) so the per-endpoint
 * handlers in this directory and the router in server.ts can both import it without a
 * cycle; server.ts re-exports it for existing importers.
 */
export type ServerDeps = {
  pool: pg.Pool;
  /**
   * Run fn inside ONE transaction (BEGIN + COMMIT/ROLLBACK). Injected per-request by
   * server.ts so handlers get atomicity. When absent (tests / CLI), handlers fall back
   * to running directly on deps.pool.
   */
  withTx?: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  summarizer: StreamingSummarizer;
  tokenBudget: number;
  model: string;
  /** Best-effort queue depths. If absent, all depths are null. */
  getQueueDepths?: () => Promise<Partial<Record<JobType, number>>>;
  /**
   * Enqueue a job on the broker bus. When absent, analysis-on-include is skipped
   * (single-user CLI mode or tests that don't wire a bus).
   */
  enqueue?: <T extends JobType>(type: T, payload: JobPayloads[T]) => Promise<void>;
  /** How old a heartbeat can be before service is considered stale (ms). Default 5 min. */
  stalenessMs?: number;
  /** Optional: current collector liveness. When absent, stale defaults to false. */
  getLiveness?: () => { healthy: boolean; lastHeartbeatAt: Date | null };
  /** Optional: run a bounded backfill for a group before summarizing. */
  backfill?: (
    groupId: number,
  ) => Promise<{ fetched: number; durationMs: number; partial: boolean }>;
  /** Target window for backfill (default 25). */
  backfillTargetWindow?: number;
  /** Optional structured logger (pino). Used to record backfill outcomes for the trace/dashboard. */
  logger?: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
  };
  /**
   * Single-user QR-link onboarding registry. When present, the /api/onboarding/*
   * endpoints (QR stream + link + status) are served against the default tenant.
   * Absent → onboarding endpoints 404.
   */
  onboarding?: OnboardingRegistry;
};
