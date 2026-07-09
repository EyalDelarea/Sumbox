import type pg from "pg";

/**
 * T5 — cross-tenant aggregates for the operator dashboard.
 *
 * These read EVERY tenant's rows at once, so they MUST run on the BYPASSRLS
 * `catchapp_operator` connection — the RLS-enforced app role can never see across
 * tenants by design. Keeping the cross-tenant reads in this one named module
 * quarantines the operator's reach the same way the auth repos quarantine login.
 */

export type TenantStat = {
  tenantId: string;
  name: string;
  status: string;
  createdAt: Date;
  groupCount: number;
  messageCount: number;
  lastSummaryAt: Date | null;
};

type Row = {
  tenant_id: string;
  name: string;
  status: string;
  created_at: Date;
  group_count: string;
  message_count: string;
  last_summary_at: Date | null;
};

/**
 * One row per tenant (including deleted ones, so lifecycle is visible), with group +
 * message counts and the freshness of its most recent summary. LEFT JOINs so a tenant
 * with no data still appears with zero counts.
 */
export async function listTenantStats(
  operatorClient: pg.Pool | pg.PoolClient,
): Promise<TenantStat[]> {
  const { rows } = await operatorClient.query<Row>(`
    SELECT t.id AS tenant_id,
           t.name,
           t.status,
           t.created_at,
           count(DISTINCT g.id) AS group_count,
           count(m.id) AS message_count,
           max(s.created_at) AS last_summary_at
    FROM tenants t
    LEFT JOIN groups g ON g.tenant_id = t.id
    LEFT JOIN messages m ON m.tenant_id = t.id
    LEFT JOIN summaries s ON s.tenant_id = t.id
    GROUP BY t.id, t.name, t.status, t.created_at
    ORDER BY t.created_at ASC
  `);
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    groupCount: Number(r.group_count),
    messageCount: Number(r.message_count),
    lastSummaryAt: r.last_summary_at,
  }));
}
