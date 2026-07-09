import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Allow 'pruned' as a new valid value for messages.media_status.
 *
 * 'pruned' means the media file was successfully analyzed/transcribed and then
 * deleted to reclaim disk space. The derived text (media_analyses.description
 * or transcripts.transcript) is the source of truth.
 *
 * The original inline check constraint was auto-named 'messages_media_status_check'
 * by PostgreSQL. We drop it (IF EXISTS for safety) and re-add a named check
 * that allows 'present', 'missing', and the new 'pruned' value.
 */
export const up = (pgm: MigrationBuilder): void => {
  // Drop the old check constraint (auto-named by Postgres from the inline CHECK).
  pgm.sql(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_status_check`);

  // Add the updated named check constraint with 'pruned' included.
  pgm.addConstraint(
    "messages",
    "messages_media_status_check",
    `CHECK (media_status IN ('present', 'missing', 'pruned') OR media_status IS NULL)`,
  );
};

export const down = (pgm: MigrationBuilder): void => {
  // Remove the updated constraint.
  pgm.dropConstraint("messages", "messages_media_status_check");

  // Re-add the original constraint (without 'pruned').
  pgm.addConstraint(
    "messages",
    "messages_media_status_check",
    `CHECK (media_status IN ('present', 'missing') OR media_status IS NULL)`,
  );
};
