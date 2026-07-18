import fs from "node:fs/promises";
import type pg from "pg";

/**
 * data-deletion.ts — destructive operations the user can run on their own data
 * (wired into Settings → Privacy & Data):
 *
 *  - deleteAllData        — wipe everything.
 *  - purgeUnselectedChats — delete every chat the user did NOT include, keeping the
 *                           selection decision so a re-sync won't silently re-pull it.
 *
 * Both follow the same two-phase contract: the DB work runs inside ONE caller-provided
 * transaction (atomic — a failure rolls back cleanly) and RETURNS the on-disk media
 * paths to remove. The caller unlinks them AFTER the commit via `unlinkMediaFiles`, so a
 * rolled-back transaction can never orphan rows whose files are already gone. Orphaned
 * files (unlink failed post-commit) are the tolerable direction and a later sweep reaps
 * them; orphaned rows are not.
 *
 * `messages.media_path` holds the ABSOLUTE path to each downloaded file, so disk cleanup
 * needs no knowledge of the import-dir layout.
 */

/**
 * Every table holding user data, ordered children-before-parents for FK-safe deletion.
 *
 * EVERY table that carries a `tenant_id` scoping column must appear here, or a wipe
 * silently leaves rows behind. `data-deletion.test.ts` enforces this against the live
 * schema (introspecting `information_schema`), with `audit_log` the one deliberate
 * exception — it is content-free and intentionally outlives a wipe.
 *
 * Children-before-parents is always FK-safe regardless of ON DELETE action; the same
 * test asserts the ordering against the live FK graph so a future table can't drift.
 */
export const SCOPED_TABLES_DELETE_ORDER = [
  // ── message/group-derived (most CASCADE from messages; listed for completeness) ──
  "read_watermarks",
  "summary_user_marks", // → summaries (SET NULL) · groups/participants (CASCADE); delete before them
  "transcripts",
  "media_analyses",
  "message_embeddings",
  "message_media",
  "suggestion_feedback",
  "suggestions",
  "todo_sources",
  "todos",
  "meeting_sources",
  "meetings",
  "people",
  "dismissed_sources",
  "dismissed_info_cards",
  "group_command_permissions",
  "chat_scopes",
  "scope_categories",
  "creation_messages",
  "creations",
  "assistant_memory",
  // ── core content + structure ──
  "messages",
  "summaries",
  "total_summaries",
  "imports",
  "participants",
  "scheduler_state",
  "job_runs",
  "identity_links",
  "user_preferences",
  "groups",
];

/**
 * Tables with a tenant_id column deliberately excluded from `SCOPED_TABLES_DELETE_ORDER`:
 * `audit_log` is content-free and is meant to survive a wipe for accountability. The
 * schema guard test treats this as the allowed exception.
 */
export const PURGE_EXCLUDED_TENANT_TABLES = ["audit_log"];

/** Best-effort unlink of media files. Missing files (ENOENT) and per-file errors never throw. */
export async function unlinkMediaFiles(
  paths: readonly string[],
  unlink: (p: string) => Promise<void> = (p) => fs.unlink(p),
): Promise<number> {
  let removed = 0;
  await Promise.all(
    paths.map(async (p) => {
      try {
        await unlink(p);
        removed++;
      } catch {
        // Already gone or unreadable — tolerable; the row is (or will be) gone too.
      }
    }),
  );
  return removed;
}

async function collectAllMediaPaths(client: pg.Pool | pg.PoolClient): Promise<string[]> {
  // Both downloaded media (messages.media_path) AND the original WhatsApp export files
  // (imports.original_file_path) — "wipe everything" must clear both off disk.
  const { rows } = await client.query<{ path: string }>(
    `SELECT media_path AS path FROM messages WHERE media_path IS NOT NULL
     UNION ALL
     SELECT original_file_path AS path FROM imports WHERE original_file_path IS NOT NULL`,
  );
  return rows.map((r) => r.path);
}

export type DeleteAllResult = {
  /** Absolute media-file paths the caller should unlink after the transaction commits. */
  mediaPaths: string[];
};

/** Wipe ALL stored data. Runs inside the caller's transaction. */
export async function deleteAllData(client: pg.Pool | pg.PoolClient): Promise<DeleteAllResult> {
  const mediaPaths = await collectAllMediaPaths(client);
  for (const table of SCOPED_TABLES_DELETE_ORDER) {
    await client.query(`DELETE FROM ${table}`);
  }
  return { mediaPaths };
}

/**
 * Group-keyed (`group_id`-bearing) tables and how `purgeUnselectedChats` treats each.
 * EVERY table with a `group_id` column must be in exactly one of these two sets — the
 * schema guard in data-deletion.test.ts enforces it against the live schema so a new
 * group-keyed table can't silently escape (or wrongly enter) the unselected-chat purge.
 *
 * Message-keyed tables (transcripts, message_media, embeddings, …) carry no `group_id`
 * and are cascade-deleted with their messages, so they're intentionally absent here.
 */
export const UNSELECTED_PURGE_GROUP_TABLES = [
  "messages",
  // @Aida's own replies in this chat — chat content like any other, and the
  // group row SURVIVES the unselected purge, so its ON DELETE CASCADE would
  // never fire and these would outlive the conversation they belong to.
  "aida_messages",
  "summaries",
  "read_watermarks",
  "summary_user_marks",
  "suggestion_feedback",
  "suggestions",
  "meetings",
  "todos",
  "dismissed_sources",
  "imports",
];

/**
 * Group-keyed tables deliberately KEPT by the unselected-chat purge:
 *  - chat_scopes: the selection decision survives a re-sync.
 *  - creations:   user-AUTHORED generative artifacts (the צור/העוזר output), not raw chat
 *    content or auto-derived analysis — out of the specced "whole chat content" scope, so
 *    we preserve them (a full account deletion still removes them). FK-safe: creations →
 *    groups, and the unselected purge always keeps the group row.
 */
export const UNSELECTED_KEEP_GROUP_TABLES = [
  "chat_scopes",
  "creations",
  "group_command_permissions",
];

export type PurgeUnselectedResult = {
  /** Number of chats (groups) whose content was deleted. */
  chatsAffected: number;
  /** Absolute media-file paths the caller should unlink after the transaction commits. */
  mediaPaths: string[];
};

/**
 * Delete the content of every chat the user did NOT include — messages, media (rows +
 * files), transcripts, analyses, embeddings, summaries, and chat-derived todos/meetings/
 * suggestions. KEEPS the `groups` and `chat_scopes` rows (so the "not included" decision
 * survives a later WhatsApp re-sync) and the cross-chat projections (`participants`,
 * `people`).
 *
 * A chat is "unselected" by the default-OFF rule: no `chat_scopes` row with
 * `included = true AND removed_at IS NULL` (mirrors `listIncludedGroupIds`).
 *
 * `olderThanDays` (used by the retention sweep) restricts deletion to dormant chats whose
 * most recent message is older than the window; omitted (the manual "purge now" button)
 * means every unselected chat regardless of age.
 */
export async function purgeUnselectedChats(
  client: pg.Pool | pg.PoolClient,
  opts: { olderThanDays?: number } = {},
): Promise<PurgeUnselectedResult> {
  const params: unknown[] = [];
  let ageClause = "";
  if (opts.olderThanDays !== undefined) {
    params.push(opts.olderThanDays);
    // Dormant only: no message newer than the window (a chat with no messages qualifies).
    ageClause = `
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.group_id = g.id AND m.sent_at >= now() - make_interval(days => $1::int)
      )`;
  }

  const { rows: groupRows } = await client.query<{ id: string }>(
    `SELECT g.id
       FROM groups g
      WHERE NOT EXISTS (
          SELECT 1 FROM chat_scopes cs
          WHERE cs.group_id = g.id AND cs.included AND cs.removed_at IS NULL
        )${ageClause}`,
    params,
  );
  const groupIds = groupRows.map((r) => Number(r.id));
  if (groupIds.length === 0) return { chatsAffected: 0, mediaPaths: [] };

  const { rows: mediaRows } = await client.query<{ path: string }>(
    `SELECT media_path AS path FROM messages
       WHERE group_id = ANY($1::bigint[]) AND media_path IS NOT NULL
     UNION ALL
     SELECT original_file_path AS path FROM imports
       WHERE group_id = ANY($1::bigint[]) AND original_file_path IS NOT NULL`,
    [groupIds],
  );
  const mediaPaths = mediaRows.map((r) => r.path);

  // Children-before-parents within the kept groups. Most rows cascade from `messages`;
  // the group-keyed rows (which would otherwise cascade from the KEPT group) are deleted
  // explicitly. Order matters only for the few non-cascading edges (read_watermarks →
  // messages); deleting watermarks before messages keeps it FK-safe.
  const ids = [groupIds];
  await client.query(`DELETE FROM dismissed_sources WHERE group_id = ANY($1::bigint[])`, ids);
  // suggestion_feedback also cascades from suggestions, but delete it explicitly by group so
  // the purge holds even if a feedback row's group ever diverged from its suggestion's.
  await client.query(`DELETE FROM suggestion_feedback WHERE group_id = ANY($1::bigint[])`, ids);
  await client.query(`DELETE FROM suggestions WHERE group_id = ANY($1::bigint[])`, ids);
  await client.query(`DELETE FROM read_watermarks WHERE group_id = ANY($1::bigint[])`, ids);
  await client.query(`DELETE FROM summary_user_marks WHERE group_id = ANY($1::bigint[])`, ids);
  await client.query(`DELETE FROM meetings WHERE group_id = ANY($1::bigint[])`, ids); // → meeting_sources
  await client.query(`DELETE FROM todos WHERE group_id = ANY($1::bigint[])`, ids); // → todo_sources
  // Cascades: transcripts, media_analyses, message_media, message_embeddings, and any
  // group_id-NULL todos/meetings whose source_message lives here; SET NULL on
  // people.next_step_source_message_id.
  await client.query(`DELETE FROM messages WHERE group_id = ANY($1::bigint[])`, ids);
  // Group-keyed (the surviving group's CASCADE never fires) and classified as
  // purge in UNSELECTED_PURGE_GROUP_TABLES — but this DELETE was missing, so
  // @Aida's marker rows (which carry the asker's question verbatim) outlived
  // the purged conversation. The behavioral test now pins list to execution.
  await client.query(`DELETE FROM aida_messages WHERE group_id = ANY($1::bigint[])`, ids);
  await client.query(`DELETE FROM summaries WHERE group_id = ANY($1::bigint[])`, ids);
  // `imports` is RESTRICT → groups (which we keep), so it never cascades — delete it
  // explicitly. messages.import_id is SET NULL and messages are already gone, so order is
  // free. Its original_file_path was collected above for unlinking.
  await client.query(`DELETE FROM imports WHERE group_id = ANY($1::bigint[])`, ids);
  // `total_summaries` is a tenant-level cross-chat aggregate (no group_id) — left intact;
  // it is rebuilt on the next digest from whatever chats remain included.

  return { chatsAffected: groupIds.length, mediaPaths };
}
