import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `rosey_tasks.kind` — what an item on Rosey's list is: a `task` (an errand,
 * chore, appointment or to-do) or a `grocery` item (a product on a shopping
 * list: milk, bread, toilet paper).
 *
 * Measured on the chat Rosey is built for, most of what she reads is a
 * shopping list, and listing "milk" beside "book the dentist" buries the real
 * tasks. The kind keeps the two apart; status (D4) is the same for both — a
 * grocery item is still bought (done) or not.
 *
 * Additive: every existing row is a 'task', which is what it was before. The
 * kind is written when an item is created (the model's label, or the
 * explicit command's) and afterwards only by hand (`rosey set --kind`): no
 * automated path rewrites the kind of an existing row, so a manual change
 * always stands.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE rosey_tasks
      ADD COLUMN kind text NOT NULL DEFAULT 'task'
        CONSTRAINT rosey_tasks_kind_check CHECK (kind IN ('task', 'grocery'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE rosey_tasks DROP COLUMN IF EXISTS kind;`);
}
