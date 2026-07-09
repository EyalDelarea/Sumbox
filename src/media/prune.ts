/**
 * pruneMediaFile — delete an on-disk media file after successful analysis.
 *
 * # Safety semantics
 *
 * - Only call AFTER a successful analysis/transcription (status='completed').
 *   Never call on failure — keep the file for retry/inspection.
 * - If `retainMedia` is true, this is a no-op.
 * - File deletion is best-effort: ENOENT is silently swallowed (file already
 *   gone). Other unlink errors (e.g. EACCES) are caught, logged as a warning,
 *   and then the DB row is still updated to 'pruned' because the derived text
 *   (description/transcript) is the source of truth. Never throws out of the
 *   caller.
 * - Idempotent: safe to call on an already-pruned row (media_path will be NULL;
 *   the UPDATE is a no-op for that field).
 *
 * # Dependencies
 *
 * - `unlink`: injectable file-delete function (defaults to `fs.rmSync(..., {force:true})`).
 *   Tests inject a fake so they don't touch the real filesystem unless they create
 *   their own temp files.
 */
import fs from "node:fs";
import type pg from "pg";
import { pruneMediaSecrets } from "../db/repositories/message-media.js";

export type PruneMediaFileDeps = {
  /**
   * When true, skip pruning entirely and leave the file and status unchanged.
   */
  retainMedia: boolean;
  /**
   * Synchronous file-delete function. Defaults to `fs.rmSync(path, { force: true })`.
   * Inject a stub in tests for hermetic FS behaviour.
   * May throw; the caller (pruneMediaFile) will catch and swallow all errors.
   */
  unlink?: (path: string) => void;
};

/**
 * Prune the on-disk media file for a message after successful analysis.
 *
 * @param client - Postgres pool or poolClient
 * @param messageId - The messages.id to prune
 * @param deps - Behaviour flags and injectable FS dep
 */
export async function pruneMediaFile(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  deps: PruneMediaFileDeps,
): Promise<void> {
  // No-op when retention is requested.
  if (deps.retainMedia) {
    return;
  }

  const unlinkFn = deps.unlink ?? ((p: string) => fs.rmSync(p, { force: true }));

  // Read the current media_path for this message.
  const { rows } = await client.query<{ media_path: string | null; media_status: string | null }>(
    `SELECT media_path, media_status FROM messages WHERE id = $1`,
    [messageId],
  );

  const row = rows[0];

  // If the row doesn't exist or is already pruned/missing with no path, just mark pruned.
  const mediaPath = row?.media_path ?? null;

  // Attempt to delete the file (best-effort).
  if (mediaPath !== null) {
    try {
      unlinkFn(mediaPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Log the warning but continue — derived text is the source of truth.
        console.warn(
          `[pruneMediaFile] failed to delete ${mediaPath} for message ${messageId}: ${String(err)}`,
        );
      }
      // ENOENT: file already gone — that's fine, still mark pruned.
    }
  }

  // Update the DB — always mark pruned, regardless of whether unlink succeeded.
  await client.query(
    `UPDATE messages SET media_status = 'pruned', media_path = NULL WHERE id = $1`,
    [messageId],
  );

  // Wipe decryption secrets (media_key, wa_message, CDN paths) from
  // message_media now that the file is gone — data-minimisation / privacy §5.
  // pruneMediaSecrets is internally guarded by `download_state = 'present'`
  // so it is a safe no-op for text/imported messages that have no media row.
  await pruneMediaSecrets(client, messageId);
}
