import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Extend `message_media.download_state` to allow the new `'minimized'` value.
 *
 * `'minimized'` = the media bytes have been purged from disk (auto-purge of
 * unselected chats after the grace window) but the descriptor row is retained.
 * Distinct from `'unrecoverable'` (CDN-lost, never downloadable) and `'pruned'`
 * (post-analysis cleanup).
 *
 * The existing CHECK constraint is recreated to add the new allowed value.
 * Down: convert any minimized rows back to 'present' first so the stricter
 * constraint can be re-applied without violating it.
 */
export function up(pgm: MigrationBuilder): void {
  // Drop the existing check constraint (the original migration used pgm.createTable
  // which names the check inline; Postgres names it message_media_download_state_check).
  pgm.sql(`ALTER TABLE message_media DROP CONSTRAINT IF EXISTS message_media_download_state_check`);

  // Re-add with the extended value set.
  pgm.addConstraint(
    "message_media",
    "message_media_download_state_check",
    `CHECK (download_state IN ('pending', 'present', 'unrecoverable', 'pruned', 'minimized'))`,
  );
}

export function down(pgm: MigrationBuilder): void {
  // Convert any minimized rows back to 'present' so the narrower constraint can land.
  pgm.sql(`UPDATE message_media SET download_state='present' WHERE download_state='minimized'`);

  pgm.sql(`ALTER TABLE message_media DROP CONSTRAINT IF EXISTS message_media_download_state_check`);

  pgm.addConstraint(
    "message_media",
    "message_media_download_state_check",
    `CHECK (download_state IN ('pending', 'present', 'unrecoverable', 'pruned'))`,
  );
}
