import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Adds `url_expires_at` to message_media: the expiry of the signed CDN URL,
 * parsed from the `oe=<hex>` query param. The media-backfill loop uses it to
 * (a) order the download queue by remaining lifetime (soonest-to-expire first)
 * and (b) skip rows whose URL has already expired — those 403 and, because the
 * reuploadRequest refresh path is broken, are unrecoverable.
 *
 * Existing rows are backfilled by parsing `oe` out of the stored `url`.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn("message_media", {
    url_expires_at: { type: "timestamptz", notNull: false },
  });

  // Backfill from the stored url's oe= hex param (unsigned unix seconds).
  // Left-pad to 16 hex digits and cast via bit(64) so the value is interpreted
  // UNSIGNED — matching the runtime parseInt(hex,16) path. (A bit(32)::int cast
  // would read oe >= 0x80000000, i.e. expiries from 2038 on, as negative.)
  pgm.sql(`
    UPDATE message_media
       SET url_expires_at = to_timestamp(
             ('x' || lpad(substring(url from 'oe=([0-9A-Fa-f]+)'), 16, '0'))::bit(64)::bigint
           )
     WHERE url ~ 'oe=[0-9A-Fa-f]+'
  `);

  // Supports both the queue's `ORDER BY url_expires_at` (under the pending
  // filter) and markExpiredMediaUnrecoverable's sweep, which both run hot
  // during a large onboarding backfill.
  pgm.createIndex("message_media", ["url_expires_at"], {
    name: "message_media_pending_url_expires_at_idx",
    where: "download_state = 'pending'",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn("message_media", "url_expires_at");
};
