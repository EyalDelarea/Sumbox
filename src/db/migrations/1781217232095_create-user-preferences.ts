import type { MigrationBuilder } from "node-pg-migrate";

// Default tenant id (migration 022). Inlined — node-pg-migrate cannot resolve
// cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// Hardened GUC read (migration 031): NULLIF treats the empty-string state a
// committed `SET LOCAL app.tenant_id` leaves behind as unset (fail closed).
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Per-tenant preferences (S5). One row per tenant, NOT columns on `users` —
 * single-user zero-config mode has no `users` row (no login, app connects as DB
 * owner, RLS dormant), but a default tenant always exists. A missing row resolves
 * to the env defaults in the repo, so the default run mode needs no row.
 *
 *   digest_times         — CSV HH:MM, same grammar as DIGEST_TIMES; scheduler reads it.
 *   morning_notification — the §1/§8 morning push toggle.
 *   engine_config        — RESERVED for the S6 suggestion engine; S5 round-trips only.
 *   theme                — nullable; client localStorage (S1) stays the source of truth.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE user_preferences (
      tenant_id uuid PRIMARY KEY
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id) ON DELETE CASCADE,
      digest_times text NOT NULL DEFAULT '08:00,18:00',
      morning_notification boolean NOT NULL DEFAULT true,
      engine_config jsonb NOT NULL DEFAULT '{}'::jsonb,
      theme text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON user_preferences
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS user_preferences");
};
