import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `rosey_task_events` — append-only status history for `rosey_tasks`.
 *
 * D4 is layered status: manual first, then a reply/react/poll on Rosey's own
 * posts, then model inference. The `source` column records which layer spoke,
 * so precedence is decidable from the log alone and a bad automated run can be
 * audited (and undone) without guessing.
 *
 * `source` values:
 *   manual   — the owner, from the local CLI/view
 *   tag      — an explicit @Rosey command in the chat
 *   reply    — a quoted reply to a Rosey post (later slice)
 *   react    — a reaction on a Rosey post (later slice)
 *   poll     — a vote on a Rosey poll (later slice; D8)
 *   inferred — the model read it from chat. Recorded, NEVER applied: it can
 *              only ever hint, it does not flip a task's status.
 *   model    — the model proposed the task (the 'suggested' creation event)
 *
 * `applied` is false when the event was recorded but did not change the task
 * (an inferred hint, or a no-op). Rows are never updated or deleted by app code;
 * they go only when their task does (ON DELETE CASCADE).
 *
 * `source_message_id` cites the chat message that caused the event, when there
 * is one. SET NULL, not CASCADE: an event carries no content of its own, and
 * the task's history should survive the deletion of one later message.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE rosey_task_events (
      id                bigserial   PRIMARY KEY,
      task_id           bigint      NOT NULL REFERENCES rosey_tasks(id) ON DELETE CASCADE,
      status            text        NOT NULL
        CHECK (status IN ('suggested', 'open', 'done', 'dropped')),
      source            text        NOT NULL
        CHECK (source IN ('manual', 'tag', 'reply', 'react', 'poll', 'inferred', 'model')),
      applied           boolean     NOT NULL,
      source_message_id bigint      REFERENCES messages(id) ON DELETE SET NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX rosey_task_events_task_idx ON rosey_task_events (task_id, created_at);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS rosey_task_events;`);
}
