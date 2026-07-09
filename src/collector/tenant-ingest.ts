import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { runWithTenantContext, scopedPool } from "../db/tenant-context.js";
import type { JobBus } from "../jobs/job-bus.js";
import type { Logger } from "../logging/logger.js";
import { handleIncomingMessage } from "./collector.js";

/**
 * T3 — tenant-attributed live ingest. One ingest function serves every session in the
 * registry: each call runs handleIncomingMessage on a pool scoped to THAT tenant and
 * inside its AsyncLocalStorage context, so rows RLS-attribute correctly and any jobs
 * the collector enqueues (transcribe/analyze) are tenant-stamped.
 */

/** The per-tenant session glue handleIncomingMessage needs (bound to that tenant's socket). */
export type TenantSessionGlue = {
  downloadVoiceNote?: (msg: WAMessage) => Promise<Buffer>;
  downloadImage?: (msg: WAMessage) => Promise<Buffer>;
  downloadVideo?: (msg: WAMessage) => Promise<Buffer>;
  groupSubject?: (jid: string) => Promise<string>;
  lidForPn?: (pn: string) => Promise<string | null>;
  pnForLid?: (lid: string) => Promise<string | null>;
};

export type TenantIngestDeps = {
  /** The RLS-enforced catchapp_app pool (raw — scoping happens per call). */
  appPool: pg.Pool;
  dataDir: string;
  /** Resolve the session glue for a tenant (bound to its live socket). */
  sessionGlue: (tenantId: string) => TenantSessionGlue;
  /** Optional job bus: voice notes/media enqueue transcribe/analyze jobs, tenant-stamped. */
  bus?: JobBus;
  /** Optional structured logger forwarded to the collector for per-message diagnostics. */
  log?: Logger;
};

export type TenantIngest = (tenantId: string, msg: WAMessage) => Promise<boolean>;

export function makeTenantIngest(deps: TenantIngestDeps): TenantIngest {
  return (tenantId: string, msg: WAMessage): Promise<boolean> => {
    const pool = scopedPool(deps.appPool, () => tenantId);
    const glue = deps.sessionGlue(tenantId);
    return runWithTenantContext(tenantId, () =>
      handleIncomingMessage(pool, msg, {
        dataDir: deps.dataDir,
        bus: deps.bus,
        log: deps.log,
        ...glue,
      }),
    );
  };
}
