import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T2 — email_tokens. Single-use, TTL'd tokens for email verification and password reset.
 * Like sessions, only SHA-256(token) is stored; the raw token travels in the emailed link.
 * Redemption looks up by token_hash before tenant context is established → operator pool.
 */
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE email_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(current_setting('app.tenant_id', true)::uuid, '${DEFAULT_TENANT_ID}')
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

    ALTER TABLE email_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_tokens FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON email_tokens
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP TABLE IF EXISTS email_tokens;`);
};
