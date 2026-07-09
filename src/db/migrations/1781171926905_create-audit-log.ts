import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T6 — append-only audit log for forensics.
 *
 * Deliberately GLOBAL (no RLS), like service_status/status_snapshots: it records
 * cross-tenant and instance-level events (operator access, tenant deletion) that no
 * single tenant owns, and it must remain readable by the operator even after a tenant's
 * data is purged. `tenant_id` is a nullable ATTRIBUTE (which tenant the event concerns),
 * NOT an RLS scoping key — and it is NOT FK'd to tenants, so a purged tenant's audit
 * trail survives the purge. actor_email is denormalized for the same reason (the user
 * row may be gone).
 *
 * Append-only by convention: the repo exposes insert + select only, never update/delete.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at timestamptz NOT NULL DEFAULT now(),
      tenant_id uuid,
      actor_user_id uuid,
      actor_email text,
      action text NOT NULL,
      ip text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
    CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);
    CREATE INDEX audit_log_action_at_idx ON audit_log (action, at DESC);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP TABLE IF EXISTS audit_log;`);
};
