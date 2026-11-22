/**
 * clone.ts — the sandbox's data: one group's rows, copied from the live
 * database into a throwaway scratch database on the same server.
 *
 * Isolation, enforced rather than promised:
 *  - The live pool is opened with `default_transaction_read_only=on`, so
 *    Postgres itself refuses any write through it; the copy reads in one
 *    REPEATABLE READ, READ ONLY transaction (a consistent snapshot).
 *  - Every write goes to a database whose name ends in SCRATCH_SUFFIX and is
 *    not the live one. Both are checked before creating, dropping or writing —
 *    by name in the URL, and again by `current_database()` on the connection.
 *  - The scratch database holds chat content, so the sandbox drops it on exit
 *    (and `rosey-sandbox --cleanup` drops a leftover one).
 *
 * What is copied — what Rosey's real code paths read for the group:
 *  - the group row and the 'rosey' row of its command permissions;
 *  - all its messages (her tasks cite messages up to 90 days back), with their
 *    transcripts and media descriptions;
 *  - the participants those messages and tasks name, and the identity links of
 *    the group's sender JIDs (resolveRaisedBy reads both);
 *  - her rosey_tasks, rosey_task_events and rosey_messages for the group;
 *  - @Aida's aida_messages markers for the group (the suggestion pass and the
 *    capture gates exclude her posts by them);
 *  - the group's Rosey cursor (scheduler_state `rosey-aggregate:<id>`).
 * Not copied: media files and their download blobs (message_media), and every
 * other group. Tenancy columns are left to their defaults; `import_id` to NULL.
 */

import pg from "pg";
import { cursorKey, setRoseyEnabled } from "../../rosey/run.js";

/** Every scratch database's name ends in this. Nothing else is ever dropped or written. */
export const SCRATCH_SUFFIX = "_rosey_sandbox";

export type ScratchTarget = {
  /** The live database's name (read only). */
  liveName: string;
  /** The scratch database's name: `<live>_rosey_sandbox`. */
  name: string;
  /** Connection string of the scratch database. */
  url: string;
  /** The same server's maintenance database, for CREATE / DROP DATABASE. */
  adminUrl: string;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Throws unless `name` is a scratch name, distinct from the live database. */
export function assertScratchName(name: string, liveName: string): void {
  if (!IDENT.test(name) || !name.endsWith(SCRATCH_SUFFIX) || name === liveName) {
    throw new Error(`refusing to use "${name}" as the sandbox database`);
  }
}

/** The scratch database for a live database URL, on the same server. */
export function scratchTarget(liveUrl: string): ScratchTarget {
  const liveName = decodeURIComponent(new URL(liveUrl).pathname.replace(/^\//, ""));
  if (!IDENT.test(liveName)) throw new Error(`unexpected live database name "${liveName}"`);
  const name = `${liveName}${SCRATCH_SUFFIX}`;
  assertScratchName(name, liveName);
  return {
    liveName,
    name,
    url: withDatabase(liveUrl, name),
    adminUrl: withDatabase(liveUrl, "postgres"),
  };
}

/**
 * A pool on the live database that Postgres keeps read-only: every transaction
 * it opens is READ ONLY, so an INSERT/UPDATE/DELETE through it fails.
 */
export function readOnlyPool(liveUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: liveUrl,
    options: "-c default_transaction_read_only=on",
    max: 2,
  });
}

async function onAdmin<T>(target: ScratchTarget, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  assertScratchName(target.name, target.liveName);
  const c = new pg.Client({ connectionString: target.adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Drop the scratch database if it exists (closing anything still connected). */
export async function dropScratch(target: ScratchTarget): Promise<void> {
  await onAdmin(target, (c) => c.query(`DROP DATABASE IF EXISTS "${target.name}" WITH (FORCE)`));
}

/**
 * A fresh, EMPTY scratch database. Migrate it next. A leftover one from a
 * crashed run is dropped first, but never one in use: a second sandbox on the
 * same server would otherwise force-drop the first one's database under it.
 */
export async function createScratch(target: ScratchTarget): Promise<void> {
  await onAdmin(target, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`,
      [target.name],
    );
    if (rows[0]!.n > 0) {
      throw new Error(
        `${target.name} is in use (${rows[0]!.n} connection(s)): another rosey-sandbox is ` +
          "running. Stop it first, or run --cleanup if it is a stale one.",
      );
    }
    await c.query(`DROP DATABASE IF EXISTS "${target.name}"`);
    await c.query(`CREATE DATABASE "${target.name}"`);
  });
}

/** Throws unless this pool is connected to a scratch database. */
export async function assertIsScratch(scratch: pg.Pool, liveName: string): Promise<void> {
  const { rows } = await scratch.query<{ db: string }>(`SELECT current_database() AS db`);
  assertScratchName(rows[0]!.db, liveName);
}

// ── The copy ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Columns never copied: the inert tenancy key, and the import a row came from. */
const SKIPPED_COLUMNS = new Set(["tenant_id", "import_id"]);

/** Copied tables, parents first. Truncating the first three cascades to the rest. */
const ROOT_TABLES = ["groups", "participants", "identity_links"] as const;

export type CloneReport = Record<string, number>;

async function columnsOf(db: pg.Pool, table: string): Promise<Set<string>> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * Insert rows read as JSON from live, by column NAME, into the same scratch
 * table. A live column the scratch schema lacks (live migrated past this
 * checkout) cannot be copied: it is reported through `warn`, not dropped silently.
 */
async function insertRows(
  scratch: pg.Pool,
  table: string,
  rows: Row[],
  warn: (line: string) => void,
): Promise<number> {
  if (rows.length === 0) return 0;
  const target = await columnsOf(scratch, table);
  const liveCols = Object.keys(rows[0]!).filter((c) => !SKIPPED_COLUMNS.has(c));
  const missing = liveCols.filter((c) => !target.has(c));
  if (missing.length > 0) {
    warn(
      `warning: ${table}.${missing.join(", ")} exist in live but not in this checkout's schema; ` +
        "not copied (update the checkout to match live)",
    );
  }
  const cols = liveCols.filter((c) => target.has(c));
  const list = cols.map((c) => `"${c}"`).join(", ");
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    await scratch.query(
      `INSERT INTO ${table} (${list})
       SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
      [JSON.stringify(batch)],
    );
  }
  if (cols.includes("id")) {
    await scratch.query(
      `SELECT setval(seq::regclass, GREATEST((SELECT max(id) FROM ${table}), 1))
         FROM pg_get_serial_sequence('${table}', 'id') AS seq WHERE seq IS NOT NULL`,
    );
  }
  return rows.length;
}

/** The group's rows as the live database holds them now, in one read-only snapshot. */
async function readGroup(live: pg.Pool, groupId: number): Promise<Record<string, Row[]>> {
  const c = await live.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const read = async (sql: string, params: unknown[]) =>
      (await c.query<{ r: Row }>(sql, params)).rows.map((x) => x.r);
    const groups = await read(`SELECT to_jsonb(g) AS r FROM groups g WHERE g.id = $1`, [groupId]);
    if (groups.length === 0) throw new Error(`group ${groupId} not found`);
    const messages = await read(
      `SELECT to_jsonb(m) AS r FROM messages m WHERE m.group_id = $1 ORDER BY m.id`,
      [groupId],
    );
    const tasks = await read(
      `SELECT to_jsonb(t) AS r FROM rosey_tasks t WHERE t.group_id = $1 ORDER BY t.id`,
      [groupId],
    );
    const participants = await read(
      `SELECT to_jsonb(p) AS r FROM participants p
        WHERE p.id IN (SELECT participant_id FROM messages WHERE group_id = $1
                       UNION SELECT raised_by_participant_id FROM rosey_tasks WHERE group_id = $1)`,
      [groupId],
    );
    const identityLinks = await read(
      `SELECT to_jsonb(il) AS r FROM identity_links il
        WHERE il.lid_jid IN (SELECT sender_jid FROM messages WHERE group_id = $1)
           OR il.pn_jid IN (SELECT sender_jid FROM messages WHERE group_id = $1)`,
      [groupId],
    );
    const byMessage = (table: string) =>
      read(
        `SELECT to_jsonb(x) AS r FROM ${table} x
          JOIN messages m ON m.id = x.message_id WHERE m.group_id = $1 ORDER BY x.id`,
        [groupId],
      );
    const out = {
      groups,
      participants,
      identity_links: identityLinks,
      messages,
      transcripts: await byMessage("transcripts"),
      media_analyses: await byMessage("media_analyses"),
      rosey_tasks: tasks,
      rosey_task_events: await read(
        `SELECT to_jsonb(e) AS r FROM rosey_task_events e
          JOIN rosey_tasks t ON t.id = e.task_id WHERE t.group_id = $1 ORDER BY e.id`,
        [groupId],
      ),
      rosey_messages: await read(
        `SELECT to_jsonb(x) AS r FROM rosey_messages x WHERE x.group_id = $1`,
        [groupId],
      ),
      aida_messages: await read(
        `SELECT to_jsonb(x) AS r FROM aida_messages x WHERE x.group_id = $1`,
        [groupId],
      ),
      scheduler_state: await read(
        `SELECT to_jsonb(s) AS r FROM scheduler_state s WHERE s.slot_key = $1`,
        [cursorKey(groupId)],
      ),
      group_command_permissions: await read(
        `SELECT to_jsonb(p) AS r FROM group_command_permissions p WHERE p.group_id = $1`,
        [groupId],
      ),
    };
    await c.query("COMMIT");
    c.release();
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    c.release(err as Error); // a client in an unknown state is discarded, not pooled
    throw err;
  }
}

/**
 * Copy one group into a migrated scratch database, then switch Rosey on for it
 * there (her real `rosey enable` path: a group she was not on starts its cursor
 * now, so history is never replayed as commands). Returns rows copied per table.
 */
export async function cloneGroup(
  live: pg.Pool,
  scratch: pg.Pool,
  groupId: number,
  liveName: string,
  warn: (line: string) => void = () => {},
): Promise<CloneReport> {
  await assertIsScratch(scratch, liveName);
  const data = await readGroup(live, groupId);
  const report: CloneReport = {};
  for (const [table, rows] of Object.entries(data)) {
    report[table] = await insertRows(scratch, table, rows, warn);
  }
  await setRoseyEnabled(scratch, groupId, true);
  return report;
}

/** Empty every copied table of the scratch database (before a re-clone). */
export async function wipeScratch(scratch: pg.Pool, liveName: string): Promise<void> {
  await assertIsScratch(scratch, liveName);
  await scratch.query(`TRUNCATE ${ROOT_TABLES.join(", ")}, scheduler_state CASCADE`);
}
