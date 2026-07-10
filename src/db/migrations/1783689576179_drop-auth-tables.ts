import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Drop the login/accounts tables. Sumbox is single-user and local-only: there is no
 * login, and nothing has read these tables since the accounts design was abandoned.
 *
 * Children before the parent (`user_sessions` and `email_tokens` both FK `users`), so
 * no CASCADE is needed. All three FK `tenants(id)`, which stays.
 *
 * `down` restores the tables to their EXACT pre-drop state — including RLS and the
 * hardened tenant_isolation policy that migration 031 installed. That fidelity is
 * load-bearing: 031's own `down` runs `DROP POLICY tenant_isolation ON users` without
 * an IF EXISTS guard, so a restore without the policy breaks the whole down chain.
 */
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS email_tokens;
    DROP TABLE IF EXISTS user_sessions;
    DROP TABLE IF EXISTS users;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      email text NOT NULL,
      password_hash text NOT NULL,
      email_verified_at timestamptz,
      consent_tos_version text,
      consent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));
    CREATE INDEX users_tenant_idx ON users (tenant_id);

    CREATE TABLE user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
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

    CREATE TABLE email_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('verify', 'reset')),
      token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz
    );
    CREATE UNIQUE INDEX email_tokens_token_hash_unique ON email_tokens (token_hash);
    CREATE INDEX email_tokens_user_idx ON email_tokens (user_id);
  `);

  for (const table of ["users", "user_sessions", "email_tokens"]) {
    pgm.sql(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = ${HARDENED_GUC})
        WITH CHECK (tenant_id = ${HARDENED_GUC});
    `);
  }
};
