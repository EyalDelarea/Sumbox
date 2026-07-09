import type pg from "pg";

/**
 * Server-side sessions. Create runs inside withTenant() (auto-attributes tenant_id).
 * Resolution from a cookie (findSessionByTokenHash) runs BEFORE tenant context exists, so
 * it MUST use a BYPASSRLS operator/admin connection; it returns the tenantId the caller
 * then uses to establish withTenant for the rest of the request.
 */

export type Session = {
  id: string;
  tenantId: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

type SessionRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

const COLS = "id, tenant_id, user_id, created_at, last_seen_at, expires_at";

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export async function createSession(
  client: pg.Pool | pg.PoolClient,
  input: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<Session> {
  const { rows } = await client.query<SessionRow>(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING ${COLS}`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
  return mapSession(rows[0]!);
}

/**
 * Resolve a session by token hash across tenants (cookie → tenant). Operator/admin
 * connection only. Returns null for unknown OR EXPIRED sessions (fail-closed on expiry).
 */
export async function findSessionByTokenHash(
  operatorClient: pg.Pool | pg.PoolClient,
  tokenHash: string,
): Promise<Session | null> {
  const { rows } = await operatorClient.query<SessionRow>(
    `SELECT ${COLS} FROM user_sessions WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ? mapSession(rows[0]) : null;
}

/** Delete a session by its token hash (logout). Safe on either pool. */
export async function deleteSessionByTokenHash(
  client: pg.Pool | pg.PoolClient,
  tokenHash: string,
): Promise<void> {
  await client.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash]);
}

/** Revoke ALL of a user's sessions (within tenant context) — e.g. after a password reset. */
export async function deleteSessionsForUser(
  client: pg.Pool | pg.PoolClient,
  userId: string,
): Promise<void> {
  await client.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

/** Bump last_seen_at for an active session (within tenant context). */
export async function touchSession(
  client: pg.Pool | pg.PoolClient,
  sessionId: string,
): Promise<void> {
  await client.query(`UPDATE user_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);
}
