import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createAdminPool } from "../client.js";
import {
  deleteTenantCompletely,
  purgeUnselectedChats,
  UNSELECTED_KEEP_GROUP_TABLES,
  UNSELECTED_PURGE_GROUP_TABLES,
  unlinkMediaFiles,
} from "./data-deletion.js";

let admin: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  admin = createAdminPool(uri);
});

afterAll(async () => {
  await admin?.end();
});

// ── Fixtures (admin bypasses RLS → set tenant_id explicitly) ────────────────────
async function newTenant(name: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')`, [id, name]);
  return id;
}

async function newGroup(tenantId: string, name: string): Promise<number> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO groups (tenant_id, name, source) VALUES ($1, $2, 'import') RETURNING id`,
    [tenantId, name],
  );
  return Number(rows[0]!.id);
}

async function newMessage(
  tenantId: string,
  groupId: number,
  opts: { mediaPath?: string; sentAt?: string } = {},
): Promise<number> {
  // tenant_id is explicit: on the admin pool the app.tenant_id GUC is unset, so the column
  // default would resolve to the DEFAULT tenant and mismatch the group's tenant (orphaning
  // it on a tenant-scoped delete). Production ingestion sets the GUC, so they always match.
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, group_id, source, message_type, sent_at, dedupe_key, media_path)
     VALUES ($1, $2, 'import', 'text', ${opts.sentAt ?? "now()"}, $3, $4) RETURNING id`,
    [tenantId, groupId, `dk-${randomUUID()}`, opts.mediaPath ?? null],
  );
  return Number(rows[0]!.id);
}

async function newImport(
  tenantId: string,
  groupId: number,
  originalFilePath: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO imports (tenant_id, group_id, source_path, source_hash, original_file_path, status)
     VALUES ($1, $2, 'src.txt', 'hash', $3, 'completed')`,
    [tenantId, groupId, originalFilePath],
  );
}

async function includeGroup(tenantId: string, groupId: number): Promise<void> {
  await admin.query(
    `INSERT INTO chat_scopes (tenant_id, group_id, included) VALUES ($1, $2, true)`,
    [tenantId, groupId],
  );
}

async function count(table: string, where: string, params: unknown[]): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0]!.n);
}

describe("purgeUnselectedChats", () => {
  it("deletes unselected chats whole, keeps included chats, group rows, and selection flags", async () => {
    const t = await newTenant("purge-unselected");
    const included = await newGroup(t, "kept");
    const unselected = await newGroup(t, "dropped");
    await includeGroup(t, included);

    const keepMsg = await newMessage(t, included);
    const dropMsg = await newMessage(t, unselected, { mediaPath: "/data/media/drop.jpg" });
    // Derived rows hanging off the unselected chat.
    await admin.query(
      `INSERT INTO todos (tenant_id, title, group_id, source_message_id) VALUES ($1, 'x', $2, $3)`,
      [t, unselected, dropMsg],
    );
    await admin.query(
      `INSERT INTO meetings (tenant_id, title, group_id, source_message_id) VALUES ($1, 'm', $2, $3)`,
      [t, unselected, dropMsg],
    );
    await admin.query(
      `INSERT INTO summaries (tenant_id, group_id, summary_type, parameters, output, model)
       VALUES ($1, $2, 'since', '{}'::jsonb, '{}'::jsonb, 'test')`,
      [t, unselected],
    );
    await newImport(t, unselected, "/data/imports/drop.txt");
    // Derived rows on the INCLUDED chat — must survive.
    await admin.query(
      `INSERT INTO todos (tenant_id, title, group_id, source_message_id) VALUES ($1, 'keep', $2, $3)`,
      [t, included, keepMsg],
    );
    await newImport(t, included, "/data/imports/keep.txt");

    const result = await purgeUnselectedChats(admin, t);

    expect(result.chatsAffected).toBe(1);
    // Both the message media and the unselected chat's original import file are returned.
    expect(result.mediaPaths.sort()).toEqual(["/data/imports/drop.txt", "/data/media/drop.jpg"]);

    // Unselected content gone (including the import row).
    expect(await count("messages", "group_id = $1", [unselected])).toBe(0);
    expect(await count("todos", "group_id = $1", [unselected])).toBe(0);
    expect(await count("meetings", "group_id = $1", [unselected])).toBe(0);
    expect(await count("summaries", "group_id = $1", [unselected])).toBe(0);
    expect(await count("imports", "group_id = $1", [unselected])).toBe(0);
    // Included content untouched.
    expect(await count("messages", "group_id = $1", [included])).toBe(1);
    expect(await count("todos", "group_id = $1", [included])).toBe(1);
    expect(await count("imports", "group_id = $1", [included])).toBe(1);
    // Both group rows survive — and the selection decision for the unselected chat persists.
    expect(await count("groups", "id = ANY($1::bigint[])", [[included, unselected]])).toBe(2);
  });

  it("is tenant-isolated — never touches another tenant's unselected chats", async () => {
    const mine = await newTenant("mine");
    const theirs = await newTenant("theirs");
    const myGroup = await newGroup(mine, "mine-drop");
    const theirGroup = await newGroup(theirs, "their-drop");
    await newMessage(mine, myGroup);
    await newMessage(theirs, theirGroup);

    await purgeUnselectedChats(admin, mine);

    expect(await count("messages", "group_id = $1", [myGroup])).toBe(0);
    expect(await count("messages", "group_id = $1", [theirGroup])).toBe(1);
  });

  it("with olderThanDays, spares unselected chats that had recent activity", async () => {
    const t = await newTenant("retention-age");
    const dormant = await newGroup(t, "dormant");
    const active = await newGroup(t, "active");
    await newMessage(t, dormant, { sentAt: "now() - interval '90 days'" });
    await newMessage(t, active, { sentAt: "now()" });

    const result = await purgeUnselectedChats(admin, t, { olderThanDays: 30 });

    expect(result.chatsAffected).toBe(1);
    expect(await count("messages", "group_id = $1", [dormant])).toBe(0);
    expect(await count("messages", "group_id = $1", [active])).toBe(1);
  });
});

describe("purgeUnselectedChats schema coverage", () => {
  it("classifies every group_id-bearing table as either purged or deliberately kept", async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'group_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    const groupKeyed = new Set(rows.map((r) => r.table_name));
    const classified = new Set([...UNSELECTED_PURGE_GROUP_TABLES, ...UNSELECTED_KEEP_GROUP_TABLES]);

    const unclassified = [...groupKeyed].filter((t) => !classified.has(t)).sort();
    expect(
      unclassified,
      `group_id tables not handled by purgeUnselectedChats (purge or keep?): ${unclassified}`,
    ).toEqual([]);

    const stale = [...classified].filter((t) => !groupKeyed.has(t)).sort();
    expect(stale, `classified tables that no longer have a group_id column: ${stale}`).toEqual([]);
  });
});

describe("deleteTenantCompletely", () => {
  it("wipes all scoped data, soft-deletes the tenant, and returns media paths", async () => {
    const t = await newTenant("full-delete");
    const g = await newGroup(t, "g");
    await newMessage(t, g, { mediaPath: "/data/media/a.jpg" });
    await newImport(t, g, "/data/imports/orig.txt");
    const {
      rows: [u],
    } = await admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'd@x.test', 'h') RETURNING id`,
      [t],
    );
    await admin.query(
      `INSERT INTO user_sessions (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'sess', now() + interval '1 hour')`,
      [t, u!.id],
    );

    const result = await deleteTenantCompletely(admin, t, { softDelete: true });

    // Both downloaded media and the original import file are returned for unlinking.
    expect(result.mediaPaths.sort()).toEqual(["/data/imports/orig.txt", "/data/media/a.jpg"]);
    expect(await count("groups", "tenant_id = $1", [t])).toBe(0);
    expect(await count("messages", "tenant_id = $1", [t])).toBe(0);
    expect(await count("user_sessions", "tenant_id = $1", [t])).toBe(0);
    const { rows } = await admin.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [t],
    );
    expect(rows[0]!.status).toBe("deleted");
  });

  it("with softDelete=false, purges data but leaves the tenant active (single-user mode)", async () => {
    const t = await newTenant("clear-only");
    const g = await newGroup(t, "g");
    await newMessage(t, g);

    await deleteTenantCompletely(admin, t, { softDelete: false });

    expect(await count("messages", "tenant_id = $1", [t])).toBe(0);
    const { rows } = await admin.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [t],
    );
    expect(rows[0]!.status).toBe("active");
  });
});

describe("unlinkMediaFiles", () => {
  it("unlinks each path and tolerates per-file errors", async () => {
    const seen: string[] = [];
    const removed = await unlinkMediaFiles(["/a", "/missing", "/b"], async (p) => {
      seen.push(p);
      if (p === "/missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(seen.sort()).toEqual(["/a", "/b", "/missing"]);
    expect(removed).toBe(2); // /missing failed but never threw
  });
});
