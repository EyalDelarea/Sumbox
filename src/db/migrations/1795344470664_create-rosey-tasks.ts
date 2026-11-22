import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `rosey_tasks` — the task list kept by Rosey (@Rosey / @רוזי), the task bot.
 *
 * Rosey is isolated from @Aida (own module, own tables, own allowlist key). This
 * table is the CURRENT state of each task; its history lives in
 * `rosey_task_events` (append-only), which is where status precedence is decided.
 *
 * ── Why a new table and not the legacy `todos` ──────────────────────────────
 * `todos.source_message_id` is UNIQUE, so one message can hold at most one
 * todo. Measured on the real chat Rosey is built for, messages are mostly
 * shopping/errand LISTS — one message, N tasks. Here the identity of a task is
 * (source_message_id, title_key): an item of a message, by its normalized title.
 * Not its position: the model labels a message's items differently from run to
 * run, so a position can name a different item on a rerun. `source_item_index`
 * is only the item's place in the list, for display order.
 *
 * ── Constraints carry the safety properties ─────────────────────────────────
 * - `source_message_id NOT NULL` + ON DELETE CASCADE: every task cites the real
 *   message it came from, and when that message is deleted (a privacy purge, an
 *   unselected-chat sweep) the task derived from it goes too. A task the model
 *   invented has no message to cite and cannot be written.
 * - `origin` separates what a member TAGGED (firm) from what the model
 *   SUGGESTED (D3: an explicit tag always wins; suggestions are only that).
 * - `status = 'suggested'` is only reachable from origin 'suggested'; a
 *   suggestion becomes a task when a person confirms it.
 * - `raised_by_participant_id` is who wrote the source message — resolved to the
 *   person's named participant row, not a raw @lid/phone JID — NOT an assignee.
 *   Nullable: some senders cannot be resolved (a group-JID fallback sender).
 * - `title_key` is the normalized title, used for the exact-match dedup step
 *   before any model is asked.
 *
 * No tenant_id: the tenancy remnants are inert (see CLAUDE.md).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE rosey_tasks (
      id                       bigserial   PRIMARY KEY,
      group_id                 bigint      NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      title                    text        NOT NULL CHECK (btrim(title) <> ''),
      title_key                text        NOT NULL,
      origin                   text        NOT NULL CHECK (origin IN ('tag', 'suggested')),
      status                   text        NOT NULL
        CHECK (status IN ('suggested', 'open', 'done', 'dropped')),
      status_source            text        NOT NULL
        CHECK (status_source IN ('manual', 'tag', 'reply', 'react', 'poll', 'inferred', 'model')),
      raised_by_participant_id bigint      REFERENCES participants(id) ON DELETE SET NULL,
      source_message_id        bigint      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_item_index        integer     NOT NULL DEFAULT 0 CHECK (source_item_index >= 0),
      raised_at                timestamptz NOT NULL,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rosey_tasks_source_title_unique UNIQUE (source_message_id, title_key),
      CONSTRAINT rosey_tasks_suggested_origin
        CHECK (status <> 'suggested' OR origin = 'suggested')
    );
  `);
  // The list view and the dedup step both read one group's live tasks, newest first.
  pgm.sql(
    `CREATE INDEX rosey_tasks_group_status_idx ON rosey_tasks (group_id, status, raised_at DESC);`,
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS rosey_tasks;`);
}
