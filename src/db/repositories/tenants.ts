import type pg from "pg";

/**
 * Tenant management. The `tenants` table is operator-level and NOT RLS-scoped, so these
 * functions run on the admin/operator connection — not inside withTenant().
 */

export type TenantStatus = "active" | "suspended" | "deleted";

export type Tenant = {
  id: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  deletedAt: Date | null;
};

type TenantRow = {
  id: string;
  name: string;
  status: TenantStatus;
  created_at: Date;
  deleted_at: Date | null;
};

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * Tables owned by a tenant, ordered children-before-parents for FK-safe deletion.
 *
 * EVERY table that carries a `tenant_id` scoping column must appear here, or a purge
 * silently leaves that tenant's rows behind. `tenants.test.ts` enforces this against
 * the live schema (introspecting `information_schema`), with `audit_log` the one
 * deliberate exception — it is content-free and intentionally outlives a purge.
 *
 * Children-before-parents is always FK-safe regardless of ON DELETE action; the same
 * test asserts the ordering against the live FK graph so a future table can't drift.
 */
export const SCOPED_TABLES_DELETE_ORDER = [
  // ── message/group-derived (most CASCADE from messages; listed for completeness) ──
  "read_watermarks",
  "summary_user_marks", // → summaries (SET NULL) · groups/participants (CASCADE); delete before them
  "transcripts",
  "media_analyses",
  "message_embeddings",
  "message_media",
  "suggestion_feedback",
  "suggestions",
  "todo_sources",
  "todos",
  "meeting_sources",
  "meetings",
  "people",
  "dismissed_sources",
  "dismissed_info_cards",
  "group_command_permissions",
  "chat_scopes",
  "scope_categories",
  "creation_messages",
  "creations",
  "assistant_memory",
  // ── core content + structure ──
  "messages",
  "summaries",
  "total_summaries",
  "imports",
  "participants",
  "scheduler_state",
  "job_runs",
  "identity_links",
  "user_preferences",
  "groups",
  // ── T2 auth tables — without these the purge leaves auth rows behind and the
  //    tenants row stays undeletable (users.tenant_id FK). ──
  "email_tokens",
  "user_sessions",
  "users",
];

/**
 * Tenant-scoped-column tables deliberately excluded from `SCOPED_TABLES_DELETE_ORDER`:
 * `audit_log` records operator access (content-free) and is meant to survive a tenant
 * purge for accountability. The schema guard test treats this as the allowed exception.
 */
export const PURGE_EXCLUDED_TENANT_TABLES = ["audit_log"];

export async function createTenant(
  client: pg.Pool | pg.PoolClient,
  input: { name: string },
): Promise<Tenant> {
  const { rows } = await client.query<TenantRow>(
    `INSERT INTO tenants (name) VALUES ($1)
     RETURNING id, name, status, created_at, deleted_at`,
    [input.name],
  );
  return mapTenant(rows[0]!);
}

export async function getTenant(
  client: pg.Pool | pg.PoolClient,
  id: string,
): Promise<Tenant | null> {
  const { rows } = await client.query<TenantRow>(
    `SELECT id, name, status, created_at, deleted_at FROM tenants WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapTenant(rows[0]) : null;
}

export async function listTenants(client: pg.Pool | pg.PoolClient): Promise<Tenant[]> {
  const { rows } = await client.query<TenantRow>(
    `SELECT id, name, status, created_at, deleted_at FROM tenants ORDER BY created_at`,
  );
  return rows.map(mapTenant);
}

export async function markTenantDeleted(
  client: pg.Pool | pg.PoolClient,
  id: string,
): Promise<void> {
  await client.query(`UPDATE tenants SET status = 'deleted', deleted_at = now() WHERE id = $1`, [
    id,
  ]);
}

/**
 * Hard data-deletion path (FR-013): remove ALL of a tenant's scoped rows. Must run on a
 * connection that can see the target tenant's rows regardless of GUC context — i.e. the
 * operator (BYPASSRLS) or admin/owner connection. Does NOT delete the tenants row itself
 * (call markTenantDeleted for the lifecycle marker).
 */
export async function purgeTenantData(
  client: pg.Pool | pg.PoolClient,
  tenantId: string,
): Promise<void> {
  for (const table of SCOPED_TABLES_DELETE_ORDER) {
    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
}
