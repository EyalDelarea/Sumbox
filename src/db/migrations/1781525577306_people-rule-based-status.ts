import type { MigrationBuilder } from "node-pg-migrate";

/**
 * People status → rule-based vocabulary (#16 §6): cooling / awaiting_reply /
 * awaiting_decision / active, plus a plain-language `reason` and a `wait_since`
 * timestamp for the urgency sort. refreshPeople rebuilds every row, so existing
 * values are coerced to 'active' rather than mapped.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE people DROP CONSTRAINT IF EXISTS people_status_check;
    UPDATE people SET status = 'active'
      WHERE status NOT IN ('cooling','awaiting_reply','awaiting_decision','active');
    ALTER TABLE people ADD CONSTRAINT people_status_check
      CHECK (status IN ('cooling','awaiting_reply','awaiting_decision','active'));
    ALTER TABLE people ADD COLUMN reason text, ADD COLUMN wait_since timestamptz;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE people DROP COLUMN IF EXISTS wait_since, DROP COLUMN IF EXISTS reason;
    ALTER TABLE people DROP CONSTRAINT IF EXISTS people_status_check;
    UPDATE people SET status = 'active'
      WHERE status NOT IN ('active','cold-lead','warm','dormant');
    ALTER TABLE people ADD CONSTRAINT people_status_check
      CHECK (status IN ('active','cold-lead','warm','dormant'));
  `);
};
