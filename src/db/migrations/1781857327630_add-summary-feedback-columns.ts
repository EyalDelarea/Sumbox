import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns("summaries", {
    rating: {
      type: "smallint",
      check: "rating IS NULL OR rating IN (1, -1)",
    },
    rating_reason: {
      type: "text",
      check:
        "rating_reason IS NULL OR rating_reason IN ('missed', 'inaccurate', 'too_long', 'too_short')",
    },
    // Self-FK: a regenerated summary points at the one it was regenerated from.
    // ON DELETE SET NULL so deleting an original (data-deletion/retention) does
    // not block or cascade-delete its regenerations.
    regenerated_from_id: {
      type: "bigint",
      references: '"summaries"',
      onDelete: "SET NULL",
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns("summaries", ["rating", "rating_reason", "regenerated_from_id"]);
};
