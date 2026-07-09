import type pg from "pg";

/**
 * Users repository. Tenant-scoped writes/reads run inside withTenant() on the app pool
 * (RLS auto-attributes + isolates). The ONE exception is findUserForLogin: login resolves
 * a user by email before the tenant is known, so it MUST run on a BYPASSRLS operator/admin
 * connection. Keeping that single cross-tenant read in one named function quarantines it.
 */

export type User = {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  consentTosVersion: string | null;
  consentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  consent_tos_version: string | null;
  consent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const COLS =
  "id, tenant_id, email, password_hash, email_verified_at, consent_tos_version, consent_at, created_at, updated_at";

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    consentTosVersion: row.consent_tos_version,
    consentAt: row.consent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Thrown when an email is already registered (global unique on lower(email)). */
export class EmailTakenError extends Error {
  constructor() {
    super("email already registered");
    this.name = "EmailTakenError";
  }
}

/**
 * Create a user in the active tenant context. tenant_id auto-attributes from the GUC.
 * Email is lowercased for the global-unique index. Throws EmailTakenError on conflict.
 */
export async function createUser(
  client: pg.Pool | pg.PoolClient,
  input: { email: string; passwordHash: string; consentTosVersion?: string | null },
): Promise<User> {
  try {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, consent_tos_version, consent_at)
       VALUES (lower($1), $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
       RETURNING ${COLS}`,
      [input.email, input.passwordHash, input.consentTosVersion ?? null],
    );
    return mapUser(rows[0]!);
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      throw new EmailTakenError();
    }
    throw err;
  }
}

/**
 * Find a user by email ACROSS ALL TENANTS for login. MUST be called with a BYPASSRLS
 * operator/admin connection — on the app pool RLS would hide users in other tenants and
 * (with no context) all users.
 */
export async function findUserForLogin(
  operatorClient: pg.Pool | pg.PoolClient,
  email: string,
): Promise<User | null> {
  const { rows } = await operatorClient.query<UserRow>(
    `SELECT ${COLS} FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Get a user by id within the active tenant context. */
export async function getUserById(
  client: pg.Pool | pg.PoolClient,
  id: string,
): Promise<User | null> {
  const { rows } = await client.query<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Mark a user's email verified (idempotent: only sets the timestamp once). */
export async function markEmailVerified(
  client: pg.Pool | pg.PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
     WHERE id = $1`,
    [userId],
  );
}

/** Replace a user's password hash (password reset). */
export async function setPasswordHash(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await client.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
    userId,
    passwordHash,
  ]);
}
