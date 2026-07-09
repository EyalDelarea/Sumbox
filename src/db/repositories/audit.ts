import type pg from "pg";

/**
 * T6 — audit log repository. APPEND-ONLY by design: insert + select only, never update
 * or delete. The table is global (no RLS), so writes work on any connection; the
 * operator reads the whole cross-tenant trail.
 */

export type AuditAction =
  | "auth.register"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.verify"
  | "auth.reset"
  | "onboarding.link"
  | "operator.access"
  | "tenant.deleted"
  | "tenant.purged"
  | (string & {});

export type AuditEntry = {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AuditRecord = {
  id: string;
  at: Date;
  tenantId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  ip: string | null;
  metadata: Record<string, unknown> | null;
};

type Row = {
  id: string;
  at: Date;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  ip: string | null;
  metadata: Record<string, unknown> | null;
};

const COLS = "id, at, tenant_id, actor_user_id, actor_email, action, ip, metadata";

function mapRow(r: Row): AuditRecord {
  return {
    id: r.id,
    at: r.at,
    tenantId: r.tenant_id,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    action: r.action,
    ip: r.ip,
    metadata: r.metadata,
  };
}

/** Append one audit event. Safe on any connection (the table is global, no RLS). */
export async function appendAudit(
  client: pg.Pool | pg.PoolClient,
  entry: AuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, actor_email, action, ip, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.tenantId ?? null,
      entry.actorUserId ?? null,
      entry.actorEmail ?? null,
      entry.action,
      entry.ip ?? null,
      entry.metadata ?? null,
    ],
  );
}

/** Recent audit entries, newest-first. Operator/admin connection (cross-tenant read). */
export async function listAudit(
  operatorClient: pg.Pool | pg.PoolClient,
  opts: { limit?: number; tenantId?: string } = {},
): Promise<AuditRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const params: unknown[] = [];
  let where = "";
  if (opts.tenantId) {
    params.push(opts.tenantId);
    where = `WHERE tenant_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await operatorClient.query<Row>(
    `SELECT ${COLS} FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapRow);
}
