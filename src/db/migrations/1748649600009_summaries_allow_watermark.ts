import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  // node-pg-migrate names inline column checks as "<table>_<column>_check".
  // Drop the existing two-value check and recreate it with 'watermark' added.
  pgm.sql(`
    ALTER TABLE summaries
      DROP CONSTRAINT IF EXISTS summaries_summary_type_check,
      ADD CONSTRAINT summaries_summary_type_check
        CHECK (summary_type IN ('last_n', 'since', 'watermark'))
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  // NOTE: down is safe only when no 'watermark' rows exist in summaries.
  pgm.sql(`
    ALTER TABLE summaries
      DROP CONSTRAINT IF EXISTS summaries_summary_type_check,
      ADD CONSTRAINT summaries_summary_type_check
        CHECK (summary_type IN ('last_n', 'since'))
  `);
};
