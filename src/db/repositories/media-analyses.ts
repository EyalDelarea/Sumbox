import type pg from "pg";
import { IMAGE_PREDICATE, kindFromFilename, VIDEO_PREDICATE } from "../../vision/media-kind.js";

export type InsertMediaAnalysisInput = {
  messageId: number;
  kind: "image" | "video";
  description: string | null;
  engine: string;
  status: "completed" | "failed";
  errorMessage?: string | null;
};

/**
 * Insert or update a media analysis row.
 *
 * Uses ON CONFLICT (message_id) DO UPDATE so that a retry after a transient
 * failure can upgrade a `failed` row to `completed` (or refresh an existing
 * completed row if re-analyzed). This replaces the previous DO NOTHING
 * behaviour which prevented recovery from failed analyses.
 */
export async function insertMediaAnalysis(
  client: pg.Pool | pg.PoolClient,
  input: InsertMediaAnalysisInput,
): Promise<void> {
  await client.query(
    `
    INSERT INTO media_analyses (message_id, kind, description, engine, status, error_message)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (message_id) DO UPDATE
      SET kind          = EXCLUDED.kind,
          description   = EXCLUDED.description,
          engine        = EXCLUDED.engine,
          status        = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          created_at    = now()
    `,
    [
      input.messageId,
      input.kind,
      input.description,
      input.engine,
      input.status,
      input.errorMessage ?? null,
    ],
  );
}

/**
 * Returns true only when a `status='completed'` media_analyses row exists for
 * the given messageId. A `failed` row returns false so the worker retries it.
 *
 * Used by the analyze handler for idempotency on redelivery.
 */
export async function hasAnalysis(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
): Promise<boolean> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM media_analyses WHERE message_id = $1 AND status = 'completed'`,
    [messageId],
  );
  return Number(rows[0].cnt) > 0;
}

/**
 * Returns the media_path and kind for a visual media message if it is present
 * on disk and has a recognised image or video extension. Returns null when the
 * message does not exist, is missing, or is not a visual media file.
 *
 * Used by the analyze worker handler to look up the file path for a single job.
 */
export async function getVisualMediaPath(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
): Promise<{ path: string; kind: "image" | "video" } | null> {
  const { rows } = await client.query<{ media_path: string; media_filename: string }>(
    `
    SELECT m.media_path, m.media_filename
    FROM messages m
    WHERE m.id = $1
      AND m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND (${IMAGE_PREDICATE} OR ${VIDEO_PREDICATE})
    `,
    [messageId],
  );
  const row = rows[0];
  if (!row) return null;
  const kind = kindFromFilename(row.media_filename);
  if (!kind) return null;
  return { path: row.media_path, kind };
}

/**
 * Returns present visual media (images and videos, excluding stickers) that
 * do NOT yet have a `completed` media_analyses row, ordered newest-first.
 *
 * Messages whose only analysis row is `failed` ARE included — they are
 * eligible for re-analysis via the analyze-backlog command (the upsert in
 * insertMediaAnalysis will upgrade failed→completed).
 *
 * Stickers (media_filename ILIKE 'STK-%') are excluded: they are never
 * analyzed and should not be enqueued.
 */
export async function selectVisualMediaNeedingAnalysis(
  client: pg.Pool | pg.PoolClient,
  limit?: number,
): Promise<{ messageId: number; kind: "image" | "video" }[]> {
  const params: unknown[] = [];
  let limitClause = "";
  if (limit !== undefined) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }

  const { rows } = await client.query<{ id: string; media_filename: string }>(
    `
    SELECT m.id, m.media_filename
    FROM messages m
    WHERE m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND (${IMAGE_PREDICATE} OR ${VIDEO_PREDICATE})
      AND m.media_filename NOT ILIKE 'STK-%'
      AND NOT EXISTS (
        SELECT 1 FROM media_analyses a
        WHERE a.message_id = m.id
          AND a.status = 'completed'
      )
    ORDER BY m.sent_at DESC, m.id DESC
    ${limitClause}
    `,
    params,
  );

  const result: { messageId: number; kind: "image" | "video" }[] = [];
  for (const row of rows) {
    const kind = kindFromFilename(row.media_filename);
    if (!kind) continue;
    result.push({ messageId: Number(row.id), kind });
  }
  return result;
}
