import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T2 — user_sessions. Server-side opaque sessions: the raw token lives only in the
 * client's httpOnly cookie; we store SHA-256(token) in token_hash. Lookup-by-token (to
 * resolve cookie → tenant + user) happens BEFORE tenant context exists, so it runs on the
 * BYPASSRLS operator connection. RLS still scopes the table for all in-tenant access.
 */
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(current_setting('app.tenant_id', true)::uuid, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );

    CREATE UNIQUE INDEX user_sessions_token_hash_unique ON user_sessions (token_hash);
    CREATE INDEX user_sessions_tenant_idx ON user_sessions (tenant_id);
    CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

    ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON user_sessions
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP TABLE IF EXISTS user_sessions;`);
};
