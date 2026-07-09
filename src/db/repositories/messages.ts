import type pg from "pg";
import type { NormalizedMessage } from "../../importer/types.js";

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

/**
 * Count readable messages for a group, using the same predicate as select.ts:
 * non-system; COALESCE(completed transcript, text_content) non-null and non-empty.
 */
export async function countReadableByGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** How many media messages (image/voice/video/etc) the group has — for the agent's
 * sense of the chat's makeup ("lots of voice notes" vs "all text"). */
export async function countMediaByGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM messages WHERE group_id = $1 AND message_type = 'media'`,
    [groupId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Newest readable message timestamp for a group (any source — live OR imported),
 * using the same readable predicate as countReadableByGroup, or null when the group
 * has no readable messages. This is the correct pre-outage baseline for the boot
 * recovery signal: countReadableSince(group, getNewestReadableSentAt(group)) is ~0
 * unless genuinely newer messages arrive. (getNewestAnchor is external_id-filtered
 * for paging and is NOT a valid measurement baseline for imported groups.)
 */
export async function getNewestReadableSentAt(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Date | null> {
  const { rows } = await client.query<{ newest: Date | null }>(
    `
    SELECT MAX(m.sent_at) AS newest
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId],
  );
  return rows[0]?.newest ?? null;
}

/**
 * Count readable messages for a group strictly newer than `since` — same readable
 * predicate as countReadableByGroup, plus sent_at > since. Used as the boot-time
 * recovery signal (how many messages came back after the pre-outage snapshot).
 */
export async function countReadableSince(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  since: Date,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.sent_at > $2
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId, since],
  );
  return Number(rows[0]?.count ?? 0);
}

export type Anchor = {
  externalId: string;
  sentAt: Date;
  fromMe: boolean;
  remoteJid: string;
};

/**
 * Return the newest message for the group that has a non-null external_id,
 * joined to the group's whatsapp_id as remoteJid.
 * fromMe is COALESCE(from_me, false).
 * Returns null when no anchorable message exists or the group has no whatsapp_id.
 */
/**
 * Return the oldest sent_at timestamp for readable messages in a group,
 * or null when the group has no messages.
 * "Readable" uses the same predicate as countReadableByGroup.
 */
export async function getOldestSentAt(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Date | null> {
  const { rows } = await client.query<{ oldest: Date | null }>(
    `
    SELECT MIN(m.sent_at) AS oldest
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId],
  );
  return rows[0]?.oldest ?? null;
}

export async function getNewestAnchor(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Anchor | null> {
  const { rows } = await client.query<{
    external_id: string;
    sent_at: Date;
    from_me: boolean;
    whatsapp_id: string;
  }>(
    `
    SELECT m.external_id,
           m.sent_at,
           COALESCE(m.from_me, false) AS from_me,
           g.whatsapp_id
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    WHERE m.group_id = $1
      AND m.external_id IS NOT NULL
      AND g.whatsapp_id IS NOT NULL
    ORDER BY m.sent_at DESC, m.id DESC
    LIMIT 1
    `,
    [groupId],
  );

  if (rows.length === 0) return null;

  const row = rows[0]!;
  return {
    externalId: row.external_id,
    sentAt: row.sent_at,
    fromMe: row.from_me,
    remoteJid: row.whatsapp_id,
  };
}

/** One message row for the thread view (Ask source-jump). */
export type ThreadMessage = {
  id: number;
  sender: string;
  text: string;
  sentAt: Date;
  fromMe: boolean;
};

/**
 * Window of messages around an anchor id within a group, ascending by
 * (sent_at, id). `limit` is split before/after the anchor (the anchor is
 * included in the "before" half). Returns [] when the anchor is not in the
 * group, so a citation that points elsewhere degrades to empty rather than
 * erroring. `text` mirrors the lexical retriever's display content
 * (text · media description · transcript), so media/voice rows still read.
 */
export async function getMessagesAround(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  aroundId: number,
  limit: number,
): Promise<ThreadMessage[]> {
  const before = Math.ceil(limit / 2);
  const after = Math.floor(limit / 2);
  const { rows } = await client.query<{
    id: string;
    sender: string;
    text: string | null;
    sent_at: Date;
    from_me: boolean;
  }>(
    `
    WITH anchor AS (
      SELECT sent_at, id FROM messages WHERE id = $2 AND group_id = $1
    ), win AS (
      (SELECT m.id FROM messages m, anchor a
        WHERE m.group_id = $1 AND m.message_type <> 'system'
          AND (m.sent_at, m.id) <= (a.sent_at, a.id)
        ORDER BY m.sent_at DESC, m.id DESC LIMIT $3)
      UNION
      (SELECT m.id FROM messages m, anchor a
        WHERE m.group_id = $1 AND m.message_type <> 'system'
          AND (m.sent_at, m.id) > (a.sent_at, a.id)
        ORDER BY m.sent_at ASC, m.id ASC LIMIT $4)
    )
    SELECT m.id,
           COALESCE(p.display_name, 'Unknown') AS sender,
           concat_ws(' — ',
             NULLIF(trim(m.text_content), ''),
             NULLIF(trim(an.description), ''),
             NULLIF(trim(t.transcript), '')
           ) AS text,
           m.sent_at,
           COALESCE(m.from_me, false) AS from_me
    FROM win
    JOIN messages m ON m.id = win.id
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses an ON an.message_id = m.id AND an.status = 'completed'
    ORDER BY m.sent_at ASC, m.id ASC
    `,
    [groupId, aroundId, before, after],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    sender: r.sender,
    text: r.text ?? "",
    sentAt: r.sent_at,
    fromMe: r.from_me,
  }));
}

/**
 * The most recent `limit` non-system messages in a group, ascending by
 * (sent_at, id) — the "show the full conversation" view when no specific
 * citation anchors the thread. Same display projection as getMessagesAround
 * (text · media description · transcript) so media/voice rows still read.
 */
export async function getRecentMessages(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  limit: number,
): Promise<ThreadMessage[]> {
  const { rows } = await client.query<{
    id: string;
    sender: string;
    text: string | null;
    sent_at: Date;
    from_me: boolean;
  }>(
    `
    WITH win AS (
      SELECT m.id FROM messages m
        WHERE m.group_id = $1 AND m.message_type <> 'system'
        ORDER BY m.sent_at DESC, m.id DESC LIMIT $2
    )
    SELECT m.id,
           COALESCE(p.display_name, 'Unknown') AS sender,
           concat_ws(' — ',
             NULLIF(trim(m.text_content), ''),
             NULLIF(trim(an.description), ''),
             NULLIF(trim(t.transcript), '')
           ) AS text,
           m.sent_at,
           COALESCE(m.from_me, false) AS from_me
    FROM win
    JOIN messages m ON m.id = win.id
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses an ON an.message_id = m.id AND an.status = 'completed'
    ORDER BY m.sent_at ASC, m.id ASC
    `,
    [groupId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    sender: r.sender,
    text: r.text ?? "",
    sentAt: r.sent_at,
    fromMe: r.from_me,
  }));
}

/**
 * True if a message with this (group_id, external_id) is already stored.
 *
 * Used by the live collector to skip the expensive — and occasionally
 * crash-prone — media download + insert for messages WhatsApp re-pushes on
 * every reconnect (the recent-history batch). Matches the (group_id, external_id)
 * partial unique index, so a hit here is exactly a row insertMessages would
 * reject as a duplicate.
 */
export async function messageExistsByExternalId(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  externalId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM messages WHERE group_id = $1 AND external_id = $2 LIMIT 1`,
    [groupId, externalId],
  );
  return rows.length > 0;
}

/**
 * Return the primary-key `id` and `media_status` of the message identified by
 * (group_id, external_id), or null when no such row exists.
 *
 * Used by the live collector's dedup branch to (re)attach a media descriptor on
 * a history re-pull while avoiding re-downloads of already-present or intentionally
 * pruned media.
 */
export async function getMessageIdByExternalId(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  externalId: string,
): Promise<{ id: number; mediaStatus: "present" | "missing" | "pruned" | null } | null> {
  const { rows } = await client.query<{
    id: string;
    media_status: "present" | "missing" | "pruned" | null;
  }>(`SELECT id, media_status FROM messages WHERE group_id = $1 AND external_id = $2 LIMIT 1`, [
    groupId,
    externalId,
  ]);
  return rows[0] ? { id: Number(rows[0].id), mediaStatus: rows[0].media_status } : null;
}

/**
 * Flip a message's media_status to 'present' and record the on-disk path.
 *
 * Called by the backfill loop once the media file has been successfully
 * downloaded and moved to its final storage location.
 */
/**
 * Mark a message's media as downloaded/present at `mediaPath`.
 *
 * Also records `media_filename` (basename of the path) when it is currently
 * blank — deferred-backfill media arrives with no filename, and the vision
 * analyzer classifies image vs. video purely from the filename extension
 * (IMAGE_PREDICATE/VIDEO_PREDICATE). Without this, every backfilled image/video
 * is `present` yet unanalyzable ("not a present visual media file"). An existing
 * non-blank filename (e.g. CSV-imported `IMG-001.jpg`) is preserved.
 */
export async function markMessageMediaPresent(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  mediaPath: string,
): Promise<void> {
  await client.query(
    `UPDATE messages
        SET media_path=$2,
            media_status='present',
            media_filename=COALESCE(NULLIF(media_filename, ''), regexp_replace($2, '^.*/', ''))
      WHERE id=$1`,
    [messageId, mediaPath],
  );
}

type MessageRow = NormalizedMessage & {
  participantId: number | null;
};

type InsertResult = {
  inserted: number;
  skipped: number;
  /** IDs of newly inserted rows (empty when all were skipped). */
  ids: number[];
};

/**
 * Batch-insert normalized messages using ON CONFLICT (group_id, dedupe_key) DO NOTHING.
 * Returns { inserted, skipped } counts.
 *
 * Each row requires a pre-resolved participantId (nullable for system messages).
 */
export async function insertMessages(
  client: pg.Pool | pg.PoolClient,
  rows: MessageRow[],
): Promise<InsertResult> {
  if (rows.length === 0) {
    return { inserted: 0, skipped: 0, ids: [] };
  }

  let insertedTotal = 0;
  const insertedIds: number[] = [];

  // Insert one row at a time to accurately track rowCount per insert.
  // For large batches this could be optimized with unnest(), but correctness is
  // the priority for Chunk 1; batching optimization is deferred.
  for (const row of rows) {
    try {
      const result = await client.query<{ id: number }>(
        `
        INSERT INTO messages
          (group_id, participant_id, import_id, source, external_id, message_type,
           text_content, media_filename, media_path, media_status, sent_at, dedupe_key,
           from_me)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (group_id, dedupe_key) DO NOTHING
        RETURNING id
        `,
        [
          row.groupId,
          row.participantId,
          row.importId,
          row.source,
          row.externalId ?? null,
          row.messageType,
          row.textContent,
          row.mediaFilename,
          row.mediaPath,
          row.mediaStatus,
          row.sentAt,
          row.dedupeKey,
          row.fromMe ?? null,
        ],
      );
      const count = result.rowCount ?? 0;
      insertedTotal += count;
      for (const r of result.rows) {
        insertedIds.push(r.id);
      }
    } catch (err: unknown) {
      // Guard against edge-case unique violation on (group_id, external_id) partial index.
      // The dedupe_key conflict already handles the common duplicate path; this catch
      // handles the rare case where two live messages share the same external_id but
      // differ in dedupe_key (should not happen in practice, but we log and skip).
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        // Unique violation — silently treat as a skipped duplicate (counted in the
        // returned `skipped` total). Logging per-row floods bulk history syncs, which
        // legitimately re-receive thousands of already-stored messages.
      } else {
        throw err;
      }
    }
  }

  return {
    inserted: insertedTotal,
    skipped: rows.length - insertedTotal,
    ids: insertedIds,
  };
}
