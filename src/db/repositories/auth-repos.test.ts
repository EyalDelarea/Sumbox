import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createTestDatabase, operatorPool } from "../../test/db.js";
import { DEFAULT_TENANT_ID, withTenant } from "../tenant-context.js";
import { consumeTokenByHash, createEmailToken, findActiveTokenByHash } from "./email-tokens.js";
import { createSession, deleteSessionByTokenHash, findSessionByTokenHash } from "./sessions.js";
import { createTenant } from "./tenants.js";
import { createUser, EmailTakenError, findUserForLogin, getUserById } from "./users.js";

/**
 * T2 auth-layer isolation + auth-before-tenant. Connects as catchapp_app (RLS enforced) and
 * catchapp_operator (BYPASSRLS) — mirroring production — so these tests actually prove
 * isolation rather than running as a superuser that bypasses it.
 */

let app: pg.Pool;
let op: pg.Pool;
const TENANT_A = DEFAULT_TENANT_ID;
let tenantB: string;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
  const b = await createTenant(op, { name: "tenant-b" });
  tenantB = b.id;
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

describe("users: creation, isolation, login lookup", () => {
  it("creates a user in the active tenant and reads it back in-context", async () => {
    const u = await withTenant(app, TENANT_A, (c) =>
      createUser(c, { email: "Alice@Example.com", passwordHash: "hash-a", consentTosVersion: "1" }),
    );
    expect(u.tenantId).toBe(TENANT_A);
    expect(u.email).toBe("alice@example.com"); // lowercased
    expect(u.consentAt).not.toBeNull();

    const back = await withTenant(app, TENANT_A, (c) => getUserById(c, u.id));
    expect(back?.id).toBe(u.id);
  });

  it("a user in tenant B is invisible from tenant A's context (RLS)", async () => {
    const ub = await withTenant(app, tenantB, (c) =>
      createUser(c, { email: "bob@example.com", passwordHash: "hash-b" }),
    );
    const fromA = await withTenant(app, TENANT_A, (c) => getUserById(c, ub.id));
    expect(fromA).toBeNull();
    const fromB = await withTenant(app, tenantB, (c) => getUserById(c, ub.id));
    expect(fromB?.id).toBe(ub.id);
  });

  it("findUserForLogin resolves a user across tenants on the operator pool", async () => {
    const found = await findUserForLogin(op, "BOB@example.com");
    expect(found?.email).toBe("bob@example.com");
    expect(found?.tenantId).toBe(tenantB);
  });

  it("enforces ONE account per email across the whole instance", async () => {
    await expect(
      withTenant(app, tenantB, (c) =>
        createUser(c, { email: "alice@example.com", passwordHash: "x" }),
      ),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });
});

describe("sessions: cookie → tenant resolution", () => {
  it("creates a session in-tenant and resolves it (with tenantId) on the operator pool", async () => {
    const user = await findUserForLogin(op, "alice@example.com");
    const tokenHash = "a".repeat(64);
    const s = await withTenant(app, TENANT_A, (c) =>
      createSession(c, {
        userId: user!.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    );
    expect(s.tenantId).toBe(TENANT_A);

    const resolved = await findSessionByTokenHash(op, tokenHash);
    expect(resolved?.userId).toBe(user!.id);
    expect(resolved?.tenantId).toBe(TENANT_A);
  });

  it("returns null for an expired session (fail-closed)", async () => {
    const user = await findUserForLogin(op, "alice@example.com");
    const tokenHash = "b".repeat(64);
    await withTenant(app, TENANT_A, (c) =>
      createSession(c, { userId: user!.id, tokenHash, expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(await findSessionByTokenHash(op, tokenHash)).toBeNull();
  });

  it("logout deletes the session", async () => {
    const user = await findUserForLogin(op, "alice@example.com");
    const tokenHash = "c".repeat(64);
    await withTenant(app, TENANT_A, (c) =>
      createSession(c, { userId: user!.id, tokenHash, expiresAt: new Date(Date.now() + 3600_000) }),
    );
    await withTenant(app, TENANT_A, (c) => deleteSessionByTokenHash(c, tokenHash));
    expect(await findSessionByTokenHash(op, tokenHash)).toBeNull();
  });
});

describe("email tokens: single-use redemption", () => {
  it("creates, finds active, and consumes exactly once", async () => {
    const user = await findUserForLogin(op, "alice@example.com");
    const tokenHash = "d".repeat(64);
    await withTenant(app, TENANT_A, (c) =>
      createEmailToken(c, {
        userId: user!.id,
        kind: "verify",
        tokenHash,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    );

    const active = await findActiveTokenByHash(op, tokenHash);
    expect(active?.kind).toBe("verify");
    expect(active?.tenantId).toBe(TENANT_A);

    const first = await withTenant(app, TENANT_A, (c) => consumeTokenByHash(c, tokenHash));
    const second = await withTenant(app, TENANT_A, (c) => consumeTokenByHash(c, tokenHash));
    expect(first).toBe(true);
    expect(second).toBe(false); // single-use
    expect(await findActiveTokenByHash(op, tokenHash)).toBeNull();
  });
});
