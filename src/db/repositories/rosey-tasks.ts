/**
 * rosey-tasks.ts — Rosey's task store: tasks, their append-only status events,
 * and the reads her capture paths need.
 *
 * Status changes go through {@link recordStatusEvent} only, which logs every
 * event (applied or not) and applies it per the D4 rule in rosey/status.ts. No
 * other writer touches `rosey_tasks.status`.
 */

import type pg from "pg";
import { type EventSource, shouldApply, type TaskStatus } from "../../rosey/status.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RoseyTaskOrigin = "tag" | "suggested";

export type RoseyTask = {
  id: number;
  groupId: number;
  title: string;
  titleKey: string;
  origin: RoseyTaskOrigin;
  status: TaskStatus;
  statusSource: EventSource;
  raisedByParticipantId: number | null;
  sourceMessageId: number;
  sourceItemIndex: number;
  raisedAt: Date;
};

type TaskRow = {
  id: string;
  group_id: string;
  title: string;
  title_key: string;
  origin: RoseyTaskOrigin;
  status: TaskStatus;
  status_source: EventSource;
  raised_by_participant_id: string | null;
  source_message_id: string;
  source_item_index: number;
  raised_at: Date;
};

const TASK_COLUMNS = `id, group_id, title, title_key, origin, status, status_source,
  raised_by_participant_id, source_message_id, source_item_index, raised_at`;

function mapTask(r: TaskRow): RoseyTask {
  return {
    id: Number(r.id),
    groupId: Number(r.group_id),
    title: r.title,
    titleKey: r.title_key,
    origin: r.origin,
    status: r.status,
    statusSource: r.status_source,
    raisedByParticipantId: r.raised_by_participant_id ? Number(r.raised_by_participant_id) : null,
    sourceMessageId: Number(r.source_message_id),
    sourceItemIndex: r.source_item_index,
    raisedAt: r.raised_at,
  };
}

type Db = pg.Pool | pg.PoolClient;

async function inTransaction<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  // A PoolClient is already one connection (the caller owns its transaction
  // scope); a Pool must hand out a dedicated client for BEGIN/COMMIT to mean anything.
  const owned = !("release" in db);
  const client = owned ? await (db as pg.Pool).connect() : (db as pg.PoolClient);
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (owned) client.release();
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────

export type InsertTaskInput = {
  groupId: number;
  title: string;
  titleKey: string;
  origin: RoseyTaskOrigin;
  raisedByParticipantId: number | null;
  sourceMessageId: number;
  sourceItemIndex: number;
  raisedAt: Date;
};

/**
 * Insert a task with its creation event. A suggestion starts 'suggested'
 * (source 'model'); a tagged item starts 'open' (source 'tag').
 *
 * Idempotent on (source message, title key), which the database enforces
 * (rosey_tasks_source_title_unique): re-reading a message cannot fork a second
 * copy of an item it already yielded — whatever its status — and returns null
 * for it. The identity is NOT the item's position: the model labels the items
 * of a message differently from run to run, so the same position can name a
 * different item on a rerun, and keying on it silently dropped the new one.
 */
export async function insertTask(db: Db, input: InsertTaskInput): Promise<number | null> {
  const [status, source]: [TaskStatus, EventSource] =
    input.origin === "tag" ? ["open", "tag"] : ["suggested", "model"];
  return inTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO rosey_tasks (group_id, title, title_key, origin, status, status_source,
                                raised_by_participant_id, source_message_id, source_item_index,
                                raised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ON CONSTRAINT rosey_tasks_source_title_unique DO NOTHING
       RETURNING id`,
      [
        input.groupId,
        input.title,
        input.titleKey,
        input.origin,
        status,
        source,
        input.raisedByParticipantId,
        input.sourceMessageId,
        input.sourceItemIndex,
        input.raisedAt,
      ],
    );
    if (rows.length === 0) return null; // this message already yielded this item
    const id = Number(rows[0]!.id);
    await c.query(
      `INSERT INTO rosey_task_events (task_id, status, source, applied, source_message_id)
       VALUES ($1, $2, $3, true, $4)`,
      [id, status, source, input.sourceMessageId],
    );
    return id;
  });
}

export type StatusEventInput = {
  taskId: number;
  status: TaskStatus;
  source: EventSource;
  sourceMessageId?: number | null;
  /** When set, the task must belong to this group (a guard for chat-driven events). */
  groupId?: number;
};

export type StatusEventResult =
  | { found: false }
  | { found: true; applied: boolean; previous: TaskStatus; current: TaskStatus };

/**
 * Record a status event and apply it if D4 says so. The event is ALWAYS logged
 * (with `applied`), so an ignored inferred hint is still visible later.
 */
export async function recordStatusEvent(
  db: Db,
  input: StatusEventInput,
): Promise<StatusEventResult> {
  return inTransaction(db, async (c) => {
    const { rows } = await c.query<{
      status: TaskStatus;
      status_source: EventSource;
      group_id: string;
    }>(`SELECT status, status_source, group_id FROM rosey_tasks WHERE id = $1 FOR UPDATE`, [
      input.taskId,
    ]);
    const row = rows[0];
    if (!row || (input.groupId !== undefined && Number(row.group_id) !== input.groupId)) {
      return { found: false };
    }
    const applied = shouldApply(
      { status: row.status, source: row.status_source },
      input.status,
      input.source,
    );
    await c.query(
      `INSERT INTO rosey_task_events (task_id, status, source, applied, source_message_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.taskId, input.status, input.source, applied, input.sourceMessageId ?? null],
    );
    if (applied) {
      await c.query(
        `UPDATE rosey_tasks SET status = $2, status_source = $3, updated_at = now() WHERE id = $1`,
        [input.taskId, input.status, input.source],
      );
    }
    return {
      found: true,
      applied,
      previous: row.status,
      current: applied ? input.status : row.status,
    };
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Live (suggested/open) tasks of a group raised within [since, until], newest
 * first, capped. The dedup step compares a new candidate against these only:
 * recurring errands ("milk") must become a NEW task each time they come back,
 * not merge forever into one that was raised months ago and never ticked off.
 */
export async function liveTasksRaisedBetween(
  db: Db,
  groupId: number,
  since: Date,
  until: Date,
  limit = 60,
): Promise<RoseyTask[]> {
  const { rows } = await db.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM rosey_tasks
      WHERE group_id = $1 AND status IN ('suggested', 'open')
        AND raised_at >= $2 AND raised_at <= $3
      ORDER BY raised_at DESC, id DESC
      LIMIT $4`,
    [groupId, since, until, limit],
  );
  return rows.map(mapTask);
}

export type RoseyTaskView = RoseyTask & { raisedBy: string | null };

/** A group's tasks for the local view: live ones always, closed ones on request. */
export async function listTasks(
  db: Db,
  groupId: number,
  opts: { includeClosed?: boolean } = {},
): Promise<RoseyTaskView[]> {
  const { rows } = await db.query<TaskRow & { raised_by: string | null }>(
    `SELECT t.id, t.group_id, t.title, t.title_key, t.origin, t.status, t.status_source,
            t.raised_by_participant_id, t.source_message_id, t.source_item_index, t.raised_at,
            p.display_name AS raised_by
       FROM rosey_tasks t
       LEFT JOIN participants p ON p.id = t.raised_by_participant_id
      WHERE t.group_id = $1 AND ($2::boolean OR t.status IN ('suggested', 'open'))
      ORDER BY t.raised_at DESC, t.id DESC`,
    [groupId, opts.includeClosed === true],
  );
  return rows.map((r) => ({ ...mapTask(r), raisedBy: r.raised_by }));
}

/** One message Rosey may read, with voice notes resolved to their transcript. */
export type RoseySourceMessage = {
  messageId: number;
  sentAt: Date;
  /** When the collector stored it (messages.created_at). */
  ingestedAt: Date;
  /** WhatsApp's message id, which the live path knows before the row id. */
  externalId: string | null;
  sender: string | null;
  content: string;
  isVoice: boolean;
};

/**
 * Messages of a group Rosey may read for task suggestions, oldest first.
 *
 * - Voice notes count: their completed transcript stands in for the text.
 * - Never @Aida's output (`aida_messages`: her replies and summary posts) nor
 *   Rosey's own (`rosey_messages`). On a shared device both echo back as
 *   ordinary `from_me` messages, and mining a bot's output as tasks would credit
 *   them to the owner.
 * - `changedSince` is the incremental cursor. It is on INGEST time
 *   (`messages.created_at`), not `sent_at`: history sync inserts old messages
 *   late, and a transcript lands minutes after its voice note, so a message is
 *   also re-read when its transcript is newer than the cursor.
 */
export async function selectSourceMessages(
  db: Db,
  groupId: number,
  opts: { sentSince: Date; changedSince: Date | null },
): Promise<RoseySourceMessage[]> {
  const { rows } = await db.query<{
    id: string;
    sent_at: Date;
    created_at: Date;
    external_id: string | null;
    sender: string | null;
    content: string;
    is_voice: boolean;
  }>(
    `SELECT m.id, m.sent_at, m.created_at, m.external_id, p.display_name AS sender,
            COALESCE(NULLIF(btrim(m.text_content), ''), btrim(t.transcript)) AS content,
            (t.id IS NOT NULL AND NULLIF(btrim(m.text_content), '') IS NULL) AS is_voice
       FROM messages m
       LEFT JOIN participants p ON p.id = m.participant_id
       LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
       LEFT JOIN aida_messages a ON a.group_id = m.group_id AND a.external_id = m.external_id
       LEFT JOIN rosey_messages r ON r.group_id = m.group_id AND r.external_id = m.external_id
      WHERE m.group_id = $1
        AND m.message_type <> 'system'
        AND m.sent_at >= $2
        AND ($3::timestamptz IS NULL OR m.created_at > $3 OR t.created_at > $3)
        AND a.external_id IS NULL
        AND r.external_id IS NULL
        AND COALESCE(NULLIF(btrim(m.text_content), ''), btrim(t.transcript), '') <> ''
      ORDER BY m.sent_at, m.id`,
    [groupId, opts.sentSince, opts.changedSince],
  );
  return rows.map((r) => ({
    messageId: Number(r.id),
    sentAt: r.sent_at,
    ingestedAt: r.created_at,
    externalId: r.external_id,
    sender: r.sender,
    content: r.content,
    isVoice: r.is_voice,
  }));
}

const NAMED = (alias: string) =>
  `(btrim(coalesce(${alias}.display_name, '')) <> ''
    AND ${alias}.display_name NOT LIKE '%@%' AND ${alias}.display_name <> 'Unknown')`;

/**
 * Who raised each message: the sender's NAMED participant row.
 *
 * A person can sit behind several participant rows — a named one, a raw @lid
 * one, a raw phone one — because a sender's display name falls back to a JID
 * when WhatsApp never delivered a push name. Resolution, in order:
 *  1. the message's own participant, if it has a real name;
 *  2. via its sender JID and that JID's lid↔pn sibling (`identity_links`): the
 *     named participant most often seen in this group under either JID;
 *  3. a `from_me` message is the device owner: the named participant with the
 *     most `from_me` messages in this group.
 * Otherwise null. A sender stored as the group's own JID with no sender JID and
 * not from_me (an old history-sync fallback) is genuinely unknown — it is left
 * unresolved rather than guessed as "the other member".
 */
export async function resolveRaisedBy(
  db: Db,
  groupId: number,
  messageIds: readonly number[],
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (messageIds.length === 0) return out;
  const { rows } = await db.query<{ id: string; raised_by: string | null }>(
    `WITH m AS (
       SELECT m.id, m.participant_id, m.from_me, m.sender_jid, ${NAMED("p")} AS named
         FROM messages m LEFT JOIN participants p ON p.id = m.participant_id
        WHERE m.id = ANY($2::bigint[]) AND m.group_id = $1
     ),
     jids AS (
       SELECT m.id, m.sender_jid AS jid FROM m WHERE m.sender_jid IS NOT NULL
       UNION
       SELECT m.id, il.pn_jid FROM m JOIN identity_links il ON il.lid_jid = m.sender_jid
       UNION
       SELECT m.id, il.lid_jid FROM m JOIN identity_links il ON il.pn_jid = m.sender_jid
     ),
     by_jid AS (
       SELECT DISTINCT ON (jids.id) jids.id, m2.participant_id
         FROM jids
         JOIN messages m2 ON m2.group_id = $1 AND m2.sender_jid = jids.jid
         JOIN participants p2 ON p2.id = m2.participant_id
        WHERE ${NAMED("p2")}
        GROUP BY jids.id, m2.participant_id
        ORDER BY jids.id, count(*) DESC, m2.participant_id
     ),
     owner AS (
       SELECT m3.participant_id
         FROM messages m3 JOIN participants p3 ON p3.id = m3.participant_id
        WHERE m3.group_id = $1 AND m3.from_me IS TRUE AND ${NAMED("p3")}
        GROUP BY m3.participant_id
        ORDER BY count(*) DESC, m3.participant_id
        LIMIT 1
     )
     SELECT m.id,
            CASE WHEN m.named THEN m.participant_id
                 ELSE COALESCE(b.participant_id,
                               CASE WHEN m.from_me IS TRUE THEN (SELECT participant_id FROM owner) END)
            END AS raised_by
       FROM m LEFT JOIN by_jid b ON b.id = m.id`,
    [groupId, messageIds],
  );
  for (const r of rows) out.set(Number(r.id), r.raised_by ? Number(r.raised_by) : null);
  return out;
}

/** The group row for a WhatsApp group JID, or null when the chat is unknown. */
export async function groupIdForJid(db: Db, jid: string): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM groups WHERE whatsapp_id = $1 LIMIT 1`,
    [jid],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** The chat JID a group is stored under (the inverse of groupIdForJid). */
export async function jidForGroupId(db: Db, groupId: number): Promise<string | null> {
  const { rows } = await db.query<{ whatsapp_id: string | null }>(
    `SELECT whatsapp_id FROM groups WHERE id = $1`,
    [groupId],
  );
  return rows[0]?.whatsapp_id ?? null;
}

/** Did Rosey send this message? (The own-echo guard; see rosey_messages.) */
export async function isRoseyPost(db: Db, groupId: number, externalId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM rosey_messages WHERE group_id = $1 AND external_id = $2`,
    [groupId, externalId],
  );
  return (rowCount ?? 0) > 0;
}

/** Of these messages, the ones some explicit command has already written an event for. */
export async function messagesWithTagEvents(
  db: Db,
  messageIds: readonly number[],
): Promise<Set<number>> {
  if (messageIds.length === 0) return new Set();
  const { rows } = await db.query<{ source_message_id: string }>(
    `SELECT DISTINCT source_message_id FROM rosey_task_events
      WHERE source = 'tag' AND source_message_id = ANY($1::bigint[])`,
    [messageIds],
  );
  return new Set(rows.map((r) => Number(r.source_message_id)));
}
