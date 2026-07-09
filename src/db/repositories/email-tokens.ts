import type pg from "pg";

/**
 * Single-use, TTL'd email tokens (verify / reset). Creation runs inside withTenant();
 * redemption looks a token up by hash before tenant context exists → operator/admin
 * connection. A token is "active" when not expired and not yet consumed.
 */

export type EmailTokenKind = "verify" | "reset";

export type EmailToken = {
  id: string;
  tenantId: string;
  userId: string;
  kind: EmailTokenKind;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

type EmailTokenRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: EmailTokenKind;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

const COLS = "id, tenant_id, user_id, kind, created_at, expires_at, consumed_at";

function mapToken(row: EmailTokenRow): EmailToken {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: row.kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export async function createEmailToken(
  client: pg.Pool | pg.PoolClient,
  input: { userId: string; kind: EmailTokenKind; tokenHash: string; expiresAt: Date },
): Promise<EmailToken> {
  const { rows } = await client.query<EmailTokenRow>(
    `INSERT INTO email_tokens (user_id, kind, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLS}`,
    [input.userId, input.kind, input.tokenHash, input.expiresAt],
  );
  return mapToken(rows[0]!);
}

/**
 * Find an ACTIVE token (not expired, not consumed) by hash, across tenants. Operator/admin
 * connection only. Returns the tenantId so the caller can withTenant() to consume it.
 */
export async function findActiveTokenByHash(
  operatorClient: pg.Pool | pg.PoolClient,
  tokenHash: string,
): Promise<EmailToken | null> {
  const { rows } = await operatorClient.query<EmailTokenRow>(
    `SELECT ${COLS} FROM email_tokens
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ? mapToken(rows[0]) : null;
}

/**
 * Atomically consume a token by hash: marks consumed_at only if still active. Returns true
 * if THIS call consumed it (single-use guarantee under races), false otherwise.
 */
export async function consumeTokenByHash(
  client: pg.Pool | pg.PoolClient,
  tokenHash: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE email_tokens SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return (rowCount ?? 0) > 0;
}
