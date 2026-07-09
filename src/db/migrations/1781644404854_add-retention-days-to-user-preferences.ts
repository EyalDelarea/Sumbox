import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Per-tenant retention window for the auto-purge of unselected chats. NULL (the default)
 * means retention is OFF — nothing auto-deletes, preserving single-user zero-config
 * behavior. When a tenant sets a positive number N, the retention sweep deletes their
 * unselected chats with no activity in the last N days.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn("user_preferences", {
    retention_days: {
      type: "integer",
      notNull: false,
      check: "retention_days IS NULL OR retention_days > 0",
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn("user_preferences", "retention_days");
};
