import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

/**
 * Identity of the tenant that owns all data predating multi-tenancy (T1). Mirrors the
 * row seeded by migration 021. Configurable via DEFAULT_TENANT_ID so the existing local
 * deployment runs as this tenant with no other configuration (FR-010).
 */
export const DEFAULT_TENANT_ID =
  process.env.DEFAULT_TENANT_ID ?? "00000000-0000-0000-0000-000000000001";

/**
 * Run a unit of work in the context of exactly one tenant. Opens a transaction on a
 * single pooled connection, sets the transaction-local `app.tenant_id` GUC (which the
 * RLS policies key off), runs `fn` with that client, and commits — or rolls back on
 * error. The GUC is transaction-local, so a pooled connection never leaks one tenant's
 * context into the next checkout.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(name, value, is_local=true) === SET LOCAL, but parameterizable.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A drop-in pg.Pool whose every query() runs inside withTenant(getTenantId()).
 *
 * Each query gets its OWN short transaction — deliberately NOT one transaction per
 * request/job, because requests and jobs can hold a model call open for minutes and an
 * idle-in-transaction connection that long blocks vacuum and pins a pool slot. A bare
 * pg.Pool autocommits each query independently anyway, so per-query scoping preserves
 * the exact semantics existing callers already have, plus tenant context.
 *
 * getTenantId is re-read on EVERY query (late binding), so one adapter built at startup
 * can serve per-job tenants via currentTenantId().
 *
 * Only query() is supported — connect()/end() etc. stay on the real pool. The cast is
 * safe for repos, which only ever call query().
 */
export function scopedPool(pool: pg.Pool, getTenantId: () => string): pg.Pool {
  const adapter = {
    query: (...args: unknown[]) =>
      withTenant(pool, getTenantId(), (client) =>
        (client.query as (...a: unknown[]) => Promise<unknown>)(...args),
      ),
  };
  return adapter as unknown as pg.Pool;
}

const tenantStorage = new AsyncLocalStorage<string>();

/**
 * Run fn with `tenantId` as the ambient tenant (AsyncLocalStorage). Used by the worker:
 * handler dependency closures are built once at startup, so the per-job tenant travels
 * here rather than through every signature.
 */
export function runWithTenantContext<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run(tenantId, fn);
}

/** The ambient tenant, or DEFAULT_TENANT_ID outside any runWithTenantContext. */
export function currentTenantId(): string {
  return tenantStorage.getStore() ?? DEFAULT_TENANT_ID;
}
