import type pg from "pg";
import type { MediaDescriptor } from "../../collector/media-descriptor.js";

export type UpsertMessageMediaInput = {
  messageId: number;
  mediaKind: "image" | "video" | "audio" | "sticker" | "document";
  mimeType: string | null;
  mediaKey: Buffer | null;
  directPath: string | null;
  url: string | null;
  fileEncSha256: Buffer | null;
  fileSha256: Buffer | null;
  mediaKeyTs: number | null;
  fileLength: number | null;
  waMessage: Buffer | null;
  downloadState: "pending" | "present" | "unrecoverable" | "pruned" | "minimized";
  /** Signed-URL expiry in unix SECONDS (from `oe=`); null when absent. */
  urlExpiresAt?: number | null;
};

/**
 * Insert or update a `message_media` row keyed on `message_id`.
 *
 * **Stable fields** (`media_key`, `wa_message`, `file_enc_sha256`,
 * `file_sha256`, `media_key_ts`) are write-once: they are kept via COALESCE so
 * the first non-NULL write wins. Subsequent upserts with a different value for
 * these fields are silently ignored, preserving the original cryptographic
 * material.
 *
 * **Volatile fields** (`direct_path`, `url`, `mime_type`, `file_length`)
 * always refresh to the incoming value, because CDN locations and metadata can
 * legitimately change between re-pulls.
 *
 * **`download_state`** only advances FROM `'pending'`. Once a row reaches
 * `'present'`, `'unrecoverable'`, or `'pruned'`, a re-pull that passes
 * `downloadState: 'pending'` cannot downgrade it. This keeps the state machine
 * monotonic and prevents race conditions between the downloader and a
 * concurrent re-import.
 */
export async function upsertMessageMedia(
  client: pg.Pool | pg.PoolClient,
  input: UpsertMessageMediaInput,
): Promise<void> {
  await client.query(
    `
    INSERT INTO message_media
      (message_id, media_kind, mime_type, media_key, direct_path, url,
       file_enc_sha256, file_sha256, media_key_ts, file_length, wa_message,
       download_state, url_expires_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
            CASE WHEN $13::bigint IS NULL THEN NULL ELSE to_timestamp($13::bigint) END, now())
    ON CONFLICT (message_id) DO UPDATE SET
      media_kind      = EXCLUDED.media_kind,
      mime_type       = COALESCE(EXCLUDED.mime_type, message_media.mime_type),
      media_key       = COALESCE(message_media.media_key, EXCLUDED.media_key),
      wa_message      = COALESCE(message_media.wa_message, EXCLUDED.wa_message),
      file_enc_sha256 = COALESCE(message_media.file_enc_sha256, EXCLUDED.file_enc_sha256),
      file_sha256     = COALESCE(message_media.file_sha256, EXCLUDED.file_sha256),
      media_key_ts    = COALESCE(message_media.media_key_ts, EXCLUDED.media_key_ts),
      direct_path     = COALESCE(EXCLUDED.direct_path, message_media.direct_path),
      url             = COALESCE(EXCLUDED.url, message_media.url),
      -- Expiry tracks the url: when a fresh url is supplied, adopt its expiry
      -- (even if NULL) so a refreshed url can never keep a stale/expired oe.
      url_expires_at  = CASE
                          WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url_expires_at
                          ELSE message_media.url_expires_at
                        END,
      file_length     = COALESCE(EXCLUDED.file_length, message_media.file_length),
      download_state  = CASE
                          WHEN message_media.download_state = 'pending'
                          THEN EXCLUDED.download_state
                          ELSE message_media.download_state
                        END,
      updated_at      = now()
    -- 'pruned' and 'unrecoverable' are terminal and immutable: a re-pull must
    -- not resurrect the secrets they deliberately dropped, nor reset their state
    -- (it can never advance back to 'pending', so refreshed bytes would be
    -- stranded anyway). 'minimized' is intentionally NOT listed here — it is
    -- mutable so that a future "re-download on include" path can refresh its
    -- volatile CDN fields (url, direct_path) without requiring a new row.
    WHERE message_media.download_state NOT IN ('pruned', 'unrecoverable')
    `,
    [
      input.messageId,
      input.mediaKind,
      input.mimeType,
      input.mediaKey,
      input.directPath,
      input.url,
      input.fileEncSha256,
      input.fileSha256,
      input.mediaKeyTs,
      input.fileLength,
      input.waMessage,
      input.downloadState,
      input.urlExpiresAt ?? null,
    ],
  );
}

export type PendingMedia = {
  messageId: number;
  /** The group this message belongs to — used by the backfill loop to gate analysis
   *  on chat selection via `isGroupIncluded`. */
  groupId: number;
  mediaKind: "image" | "video" | "audio" | "sticker" | "document";
  waMessage: Buffer | null;
};

/**
 * Returns up to `limit` rows whose `download_state` is `'pending'`, ordered by
 * **CDN lifetime** — soonest-to-expire (`url_expires_at ASC`) first — so the
 * throttled downloader spends its budget on the media most at risk of expiring
 * before we reach it. Rows with no known expiry sort last (then oldest-first).
 *
 * Rows whose signed URL has **already expired** (`url_expires_at <= now()`) are
 * excluded: they return 403 and, with the reuploadRequest refresh path broken,
 * are unrecoverable — retrying them only burns the queue. `markExpiredMediaUnrecoverable`
 * is responsible for retiring them.
 *
 * Rows that have reached `maxAttempts` are excluded so persistently-failing
 * downloads cannot starve newer items in the queue.
 *
 * Only media kinds that can be analyzed (`image`, `video`, `audio`) are
 * returned — `sticker` and `document` rows are skipped because
 * `analysisJobFor` returns null for them.
 *
 * The JOIN to `messages` is solely for the tie-break ordering — no message
 * fields are returned in the result set.
 */
export async function selectPendingMedia(
  client: pg.Pool | pg.PoolClient,
  limit: number,
  maxAttempts = 5,
): Promise<PendingMedia[]> {
  const { rows } = await client.query<{
    message_id: string;
    group_id: string;
    media_kind: PendingMedia["mediaKind"];
    wa_message: Buffer | null;
  }>(
    `
    SELECT mm.message_id, m.group_id, mm.media_kind, mm.wa_message
    FROM message_media mm
    JOIN messages m ON m.id = mm.message_id
    LEFT JOIN chat_scopes cs ON cs.group_id = m.group_id AND cs.removed_at IS NULL
    WHERE mm.download_state = 'pending'
      AND mm.attempts < $1
      AND mm.media_kind IN ('image', 'video', 'audio')
      AND (mm.url_expires_at IS NULL OR mm.url_expires_at > now())
    -- Capture the user's INCLUDED chats first (what they'll actually summarize),
    -- then by expiry urgency. Unselected media is best-effort — it's auto-purged
    -- after the grace window anyway (see auto-purge), so deferring it under a long
    -- backlog is acceptable; included media must not wait behind it.
    ORDER BY COALESCE(cs.included, false) DESC, mm.url_expires_at ASC NULLS LAST, m.sent_at ASC, mm.message_id ASC
    LIMIT $2
    `,
    [maxAttempts, limit],
  );
  return rows.map((r) => ({
    messageId: Number(r.message_id),
    groupId: Number(r.group_id),
    mediaKind: r.media_kind,
    waMessage: r.wa_message,
  }));
}

export async function markMediaPresent(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  directPath: string | null,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET download_state='present', direct_path=COALESCE($2, direct_path),
           last_error=NULL, updated_at=now()
     WHERE message_id=$1`,
    [messageId, directPath],
  );
}

/**
 * Marks a row `unrecoverable` AND drops its cryptographic material
 * (`media_key`, `wa_message`, `direct_path`, `url`). Once we've given up, the
 * key + proto blob can never produce bytes, so retaining them only adds privacy
 * exposure (data-minimization — see deep-history-via-full-sync). Distinct from
 * `pruneMediaSecrets`, which is the post-analysis cleanup for `present` rows.
 */
export async function markMediaUnrecoverable(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET download_state='unrecoverable', last_error=$2,
           media_key=NULL, wa_message=NULL, direct_path=NULL, url=NULL,
           updated_at=now()
     WHERE message_id=$1`,
    [messageId, error],
  );
}

/**
 * Retires every `pending` row whose signed URL has already expired
 * (`url_expires_at <= now()`): flips it to `unrecoverable` and prunes secrets.
 * These would 403 on download and cannot be refreshed (reuploadRequest broken),
 * so this both saves the queue from doomed attempts and minimizes retained data.
 * Returns the number of rows retired. Cheap enough to run each backfill sweep.
 */
export async function markExpiredMediaUnrecoverable(
  client: pg.Pool | pg.PoolClient,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE message_media
       SET download_state='unrecoverable',
           last_error='signed URL expired before download (oe passed; reupload unavailable)',
           media_key=NULL, wa_message=NULL, direct_path=NULL, url=NULL,
           updated_at=now()
     WHERE download_state='pending' AND url_expires_at IS NOT NULL AND url_expires_at <= now()`,
  );
  return rowCount ?? 0;
}

export async function recordMediaAttempt(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET attempts = attempts + 1, last_error=$2, updated_at=now()
     WHERE message_id=$1`,
    [messageId, error],
  );
}

/**
 * Drops the decryption key, proto blob, and CDN location for a message once
 * its media has been analyzed, so this sensitive material is not retained
 * longer than necessary (privacy / data-minimization).
 *
 * **Precondition guard**: the UPDATE only runs when
 * `download_state = 'present'`. Calling this on a `'pending'` row is a
 * safe no-op — the row is left completely unchanged, preventing the row from
 * being permanently stranded in a state where it can never be downloaded
 * (the upsert state machine only advances FROM `'pending'` and would never
 * be able to re-set a `'pruned'` row back to `'present'`).
 */
// ── Aggregate counts ──────────────────────────────────────────────────────────

/** All known download_state values — ensures absent states return 0, not undefined. */
const DOWNLOAD_STATES = ["pending", "present", "unrecoverable", "pruned", "minimized"] as const;

/**
 * Returns a count per `download_state` value across the entire `message_media`
 * table. Every known state is always present in the result (defaulting to 0 for
 * states with no rows). Used by the operator dashboard to give visibility into
 * the first big media pull.
 */
export async function countByDownloadState(
  client: pg.Pool | pg.PoolClient,
): Promise<Record<string, number>> {
  const { rows } = await client.query<{ download_state: string; n: string }>(
    `SELECT download_state, COUNT(*)::text AS n
       FROM message_media
      GROUP BY download_state`,
  );
  const result: Record<string, number> = Object.fromEntries(DOWNLOAD_STATES.map((s) => [s, 0]));
  for (const row of rows) {
    result[row.download_state] = Number(row.n);
  }
  return result;
}

// ── Descriptor mapping ────────────────────────────────────────────────────────

/**
 * Map an extracted MediaDescriptor (+ download state) to the repository's upsert
 * input, coercing the Uint8Array fields to Buffer. Single source of truth so the
 * live collector, full-sync, and the media-backfill CLI all stay consistent.
 */
export function descriptorToUpsertInput(
  messageId: number,
  descriptor: MediaDescriptor,
  state: "pending" | "present",
): UpsertMessageMediaInput {
  return {
    messageId,
    mediaKind: descriptor.mediaKind,
    mimeType: descriptor.mimeType,
    mediaKey: descriptor.mediaKey ? Buffer.from(descriptor.mediaKey) : null,
    directPath: descriptor.directPath,
    url: descriptor.url,
    fileEncSha256: descriptor.fileEncSha256 ? Buffer.from(descriptor.fileEncSha256) : null,
    fileSha256: descriptor.fileSha256 ? Buffer.from(descriptor.fileSha256) : null,
    mediaKeyTs: descriptor.mediaKeyTs,
    fileLength: descriptor.fileLength,
    waMessage: Buffer.from(descriptor.waMessage),
    downloadState: state,
    urlExpiresAt: descriptor.urlExpiresAt,
  };
}

export type PresentUnanalyzedMedia = {
  messageId: number;
  mediaKind: "image" | "video" | "audio";
};

/**
 * Returns all media rows for the given group that are downloaded (`download_state='present'`)
 * but have not yet been successfully analyzed. This covers both image/video (no completed
 * media_analyses row) and audio (no transcripts row).
 *
 * Used by the scopes handler to enqueue analysis when a chat is flipped to `included`.
 * Only the analyzable kinds (image, video, audio) are returned — sticker and document
 * are skipped because they have no analysis job.
 */
export async function selectPresentUnanalyzedMediaByGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<PresentUnanalyzedMedia[]> {
  const { rows } = await client.query<{
    message_id: string;
    media_kind: PresentUnanalyzedMedia["mediaKind"];
  }>(
    `
    SELECT mm.message_id, mm.media_kind
    FROM message_media mm
    JOIN messages m ON m.id = mm.message_id
    WHERE mm.download_state = 'present'
      AND m.group_id = $1
      AND mm.media_kind IN ('image', 'video', 'audio')
      AND (
        -- image/video: no completed media_analyses row
        (mm.media_kind IN ('image', 'video') AND NOT EXISTS (
          SELECT 1 FROM media_analyses a
          WHERE a.message_id = mm.message_id AND a.status = 'completed'
        ))
        OR
        -- audio: no transcripts row at all
        (mm.media_kind = 'audio' AND NOT EXISTS (
          SELECT 1 FROM transcripts t
          WHERE t.message_id = mm.message_id
        ))
      )
    ORDER BY m.sent_at ASC, mm.message_id ASC
    `,
    [groupId],
  );
  return rows.map((r) => ({
    messageId: Number(r.message_id),
    mediaKind: r.media_kind,
  }));
}

export async function pruneMediaSecrets(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET media_key=NULL, wa_message=NULL, direct_path=NULL, url=NULL,
           download_state='pruned', updated_at=now()
     WHERE message_id=$1 AND download_state = 'present'`,
    [messageId],
  );
}

// ── Auto-purge (unselected media grace-window sweep) ─────────────────────────

export type MinimizableMedia = {
  messageId: number;
  /** Absolute path to the media file on disk (from messages.media_path). */
  mediaPath: string | null;
};

/**
 * Returns rows eligible for minimization:
 *  - `download_state = 'present'` on the media row
 *  - The message's group is NOT included (no active chat_scopes row with included=true)
 *  - `message_media.updated_at < now() - olderThanMs` (grace window check)
 *
 * Uses `messages.media_path` as the file-path source because that is where
 * `markMessageMediaPresent` (the backfill write path) stores the absolute path.
 */
export async function selectMinimizableMedia(
  client: pg.Pool | pg.PoolClient,
  olderThanMs: number,
): Promise<MinimizableMedia[]> {
  const { rows } = await client.query<{
    message_id: string;
    media_path: string | null;
  }>(
    `
    SELECT mm.message_id, msg.media_path
    FROM message_media mm
    JOIN messages msg ON msg.id = mm.message_id
    LEFT JOIN chat_scopes cs
           ON cs.group_id = msg.group_id
          AND cs.removed_at IS NULL
    WHERE mm.download_state = 'present'
      AND COALESCE(cs.included, false) = false
      AND mm.updated_at < now() - ($1::bigint * interval '1 millisecond')
    ORDER BY mm.updated_at ASC, mm.message_id ASC
    `,
    [olderThanMs],
  );
  return rows.map((r) => ({
    messageId: Number(r.message_id),
    mediaPath: r.media_path,
  }));
}

/**
 * Mark a media row as `'minimized'`: the bytes are gone from disk but the
 * descriptor is kept. Mirrors `pruneMediaSecrets` but:
 *  - Sets state to `'minimized'` (not `'pruned'`)
 *  - Does NOT null the cryptographic material (we keep it so a later include
 *    could re-download if CDN is still alive)
 *  - Nulls `messages.media_path` (the file-pointer) because the file is gone
 *
 * Only fires when `download_state = 'present'` so it is a safe no-op if called
 * on an already-minimized or otherwise non-present row.
 */
export async function markMinimized(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET download_state='minimized', updated_at=now()
     WHERE message_id=$1 AND download_state='present'`,
    [messageId],
  );
  // Null the file pointer on the message row (the bytes are gone).
  await client.query(
    `UPDATE messages
       SET media_path=NULL
     WHERE id=$1`,
    [messageId],
  );
}
