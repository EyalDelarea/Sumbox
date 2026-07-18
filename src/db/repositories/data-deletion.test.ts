import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createAdminPool } from "../client.js";
import {
  deleteAllData,
  PURGE_EXCLUDED_TENANT_TABLES,
  purgeUnselectedChats,
  SCOPED_TABLES_DELETE_ORDER,
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

// Tenancy used to isolate these cases from one another. Without it, every test starts
// from an empty store instead.
beforeEach(async () => {
  await deleteAllData(admin);
});

// ── Fixtures ───────────────────────────────────────────────────────────────────
// tenant_id is left to its column DEFAULT, which resolves to the seeded default tenant.
async function newGroup(name: string): Promise<number> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO groups (name, source) VALUES ($1, 'import') RETURNING id`,
    [name],
  );
  return Number(rows[0]!.id);
}

async function newMessage(
  groupId: number,
  opts: { mediaPath?: string; sentAt?: string } = {},
): Promise<number> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO messages (group_id, source, message_type, sent_at, dedupe_key, media_path)
     VALUES ($1, 'import', 'text', ${opts.sentAt ?? "now()"}, $2, $3) RETURNING id`,
    [groupId, `dk-${randomUUID()}`, opts.mediaPath ?? null],
  );
  return Number(rows[0]!.id);
}

async function newImport(groupId: number, originalFilePath: string): Promise<void> {
  await admin.query(
    `INSERT INTO imports (group_id, source_path, source_hash, original_file_path, status)
     VALUES ($1, 'src.txt', 'hash', $2, 'completed')`,
    [groupId, originalFilePath],
  );
}

async function includeGroup(groupId: number): Promise<void> {
  await admin.query(`INSERT INTO chat_scopes (group_id, included) VALUES ($1, true)`, [groupId]);
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
    const included = await newGroup("kept");
    const unselected = await newGroup("dropped");
    await includeGroup(included);

    const keepMsg = await newMessage(included);
    const dropMsg = await newMessage(unselected, { mediaPath: "/data/media/drop.jpg" });
    // Derived rows hanging off the unselected chat.
    await admin.query(
      `INSERT INTO todos (title, group_id, source_message_id) VALUES ('x', $1, $2)`,
      [unselected, dropMsg],
    );
    await admin.query(
      `INSERT INTO meetings (title, group_id, source_message_id) VALUES ('m', $1, $2)`,
      [unselected, dropMsg],
    );
    await admin.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model)
       VALUES ($1, 'since', '{}'::jsonb, '{}'::jsonb, 'test')`,
      [unselected],
    );
    await newImport(unselected, "/data/imports/drop.txt");
    // Derived rows on the INCLUDED chat — must survive.
    await admin.query(
      `INSERT INTO todos (title, group_id, source_message_id) VALUES ('keep', $1, $2)`,
      [included, keepMsg],
    );
    await newImport(included, "/data/imports/keep.txt");

    const result = await purgeUnselectedChats(admin);

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

  it("purges @Aida's own replies with the chat they belong to", async () => {
    // aida_messages was CLASSIFIED as purge (UNSELECTED_PURGE_GROUP_TABLES) but
    // purgeUnselectedChats never actually deleted it — the list and the DELETE
    // block drifted, and no behavioral test noticed. The rows carry the asker's
    // question verbatim, so surviving a purge is chat content outliving the
    // conversation it belongs to.
    const unselected = await newGroup("aida-drop");
    const included = await newGroup("aida-keep");
    await admin.query(`INSERT INTO chat_scopes (group_id, included) VALUES ($1, true)`, [included]);
    await admin.query(
      `INSERT INTO aida_messages (group_id, external_id, question) VALUES ($1, 'AIDA-D1', 'מה קורה?')`,
      [unselected],
    );
    await admin.query(
      `INSERT INTO aida_messages (group_id, external_id, question) VALUES ($1, 'AIDA-K1', 'מתי נפגשים?')`,
      [included],
    );

    await purgeUnselectedChats(admin);

    expect(await count("aida_messages", "group_id = $1", [unselected])).toBe(0);
    expect(await count("aida_messages", "group_id = $1", [included])).toBe(1);
  });

  it("with olderThanDays, spares unselected chats that had recent activity", async () => {
    const dormant = await newGroup("dormant");
    const active = await newGroup("active");
    await newMessage(dormant, { sentAt: "now() - interval '90 days'" });
    await newMessage(active, { sentAt: "now()" });

    const result = await purgeUnselectedChats(admin, { olderThanDays: 30 });

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

describe("deleteAllData", () => {
  it("wipes all stored data and returns media paths", async () => {
    const g = await newGroup("g");
    await newMessage(g, { mediaPath: "/data/media/a.jpg" });
    await newImport(g, "/data/imports/orig.txt");

    const result = await deleteAllData(admin);

    // Both downloaded media and the original import file are returned for unlinking.
    expect(result.mediaPaths.sort()).toEqual(["/data/imports/orig.txt", "/data/media/a.jpg"]);
    expect(await count("groups", "true", [])).toBe(0);
    expect(await count("messages", "true", [])).toBe(0);
    expect(await count("imports", "true", [])).toBe(0);
  });
});

/**
 * Schema guard — a wipe that misses a scoped table silently leaves data behind. Rather
 * than trust the hand-maintained list, assert it against the LIVE schema so a new
 * `tenant_id` table can't ship without being wiped (or explicitly excused).
 */
describe("SCOPED_TABLES_DELETE_ORDER schema coverage", () => {
  it("covers every table that carries a tenant_id column (minus explicit exclusions)", async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    const scopedInDb = new Set(rows.map((r) => r.table_name));
    const listed = new Set([...SCOPED_TABLES_DELETE_ORDER, ...PURGE_EXCLUDED_TENANT_TABLES]);

    // Every scoped table is accounted for (the leak-catcher).
    const missing = [...scopedInDb].filter((t) => !listed.has(t)).sort();
    expect(missing, `scoped tables missing from the delete list: ${missing}`).toEqual([]);

    // No stale entries (a listed table that no longer carries tenant_id).
    const stale = SCOPED_TABLES_DELETE_ORDER.filter((t) => !scopedInDb.has(t)).sort();
    expect(stale, `delete-list tables that no longer have a tenant_id column: ${stale}`).toEqual(
      [],
    );
  });

  it("orders children before parents for every intra-list foreign key", async () => {
    const { rows } = await admin.query<{ child: string; parent: string }>(
      `SELECT cl.relname AS child, pl.relname AS parent
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class pl ON pl.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'`,
    );
    const pos = new Map(SCOPED_TABLES_DELETE_ORDER.map((t, i) => [t, i]));
    const violations: string[] = [];
    for (const { child, parent } of rows) {
      if (child === parent) continue; // self-reference: one DELETE handles the whole set
      const ci = pos.get(child);
      const pi = pos.get(parent);
      if (ci === undefined || pi === undefined) continue; // edge to a non-scoped table (e.g. tenants)
      if (ci > pi) violations.push(`${child} (#${ci}) must precede ${parent} (#${pi})`);
    }
    expect(violations, `FK ordering violations:\n${violations.join("\n")}`).toEqual([]);
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
