import type pg from "pg";
import { AUDIO_PREDICATE } from "../db/repositories/transcripts.js";
import { IMAGE_PREDICATE, VIDEO_PREDICATE } from "../vision/media-kind.js";

export type SelectedMessage = {
  sentAt: Date;
  sender: string;
  content: string;
};

/** A position in conversation order: messages are totally ordered by (sent_at, id). */
export type Cursor = { sentAt: Date; messageId: number };

/** A selected message that also carries its own cursor, so the caller can read
 *  the last element as the new watermark. */
export type SelectedMessageWithCursor = SelectedMessage & { messageId: number };

export type Selection = { last: number } | { since: Date };

/**
 * The `/סיכום` bot-command trigger, excluded from summarized content everywhere:
 * it is a command, not conversation, and would otherwise show up as "someone
 * said /סיכום". Mirrors SUMMARY_COMMAND in collector/summary-command.ts (a fixed
 * literal, inlined here to keep the summarization layer from importing the
 * collector). Safe to interpolate — a hardcoded constant, no user input.
 */
// coalesce so a NULL text_content (media / voice-note rows) is kept — a bare
// `trim(NULL) <> '…'` is NULL, which would silently drop every media message.
//
// Prefix match, mirroring isSummaryTrigger in collector/summary-command.ts: the
// collector now fires on `/סיכום <anything>`, so excluding only the bare literal
// would let every invocation WITH trailing text back into the corpus as content
// ("someone said /סיכום אוהבים אותך"). The two rules have to move together.
//
// The `' '` boundary mirrors isSummaryTrigger's whitespace check so `/סיכוםX` —
// a different word — is still ordinary conversation. Safe to interpolate: a
// hardcoded constant, never user input.
const EXCLUDE_SUMMARY_COMMAND =
  "AND coalesce(trim(m.text_content), '') NOT IN ('/סיכום') " +
  "AND coalesce(trim(m.text_content), '') NOT LIKE '/סיכום ' || '%'";

/**
 * Read content-bearing messages for a group, transcript substituting for voice
 * notes (FR-016). System messages and rows with no usable content are excluded.
 * `last` returns the newest N then ordered chronologically; `since` returns all
 * messages on/after the date, chronologically. Empty selection → [] (FR-019).
 */
export async function selectMessages(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  selection: Selection,
): Promise<SelectedMessageWithCursor[]> {
  const base = `
    SELECT m.sent_at,
           m.id,
           COALESCE(p.display_name, 'Unknown') AS sender,
           concat_ws(' — ',
             NULLIF(trim(m.text_content), ''),
             NULLIF(trim(a.description), ''),
             NULLIF(trim(t.transcript), '')
           ) AS content
    FROM messages m
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      ${EXCLUDE_SUMMARY_COMMAND}
      AND concat_ws(' — ',
            NULLIF(trim(m.text_content), ''),
            NULLIF(trim(a.description), ''),
            NULLIF(trim(t.transcript), '')
          ) <> ''
  `;

  let rows: { sent_at: Date; id: string; sender: string; content: string }[];

  if ("last" in selection) {
    const res = await client.query<{ sent_at: Date; id: string; sender: string; content: string }>(
      `${base} ORDER BY m.sent_at DESC, m.id DESC LIMIT $2`,
      [groupId, selection.last],
    );
    rows = res.rows.reverse(); // newest N -> chronological
  } else {
    const res = await client.query<{ sent_at: Date; id: string; sender: string; content: string }>(
      `${base} AND m.sent_at >= $2 ORDER BY m.sent_at ASC, m.id ASC`,
      [groupId, selection.since],
    );
    rows = res.rows;
  }

  return rows.map((r) => ({
    sentAt: r.sent_at,
    sender: r.sender,
    content: r.content,
    messageId: Number(r.id),
  }));
}

/**
 * Read content-bearing messages STRICTLY after a `(sent_at, id)` cursor, in
 * ascending conversation order. Uses the same transcript-substitution and
 * content filter as `selectMessages` (system messages and empty rows excluded,
 * transcript standing in for a voice note). Each result carries its own
 * `messageId` + `sentAt` so the caller can read the last element as the new
 * watermark. Used by the catch-up flow (004).
 */
export async function selectAfterCursor(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  cursor: Cursor,
): Promise<SelectedMessageWithCursor[]> {
  const { rows } = await client.query<{
    id: string;
    sent_at: Date;
    sender: string;
    content: string;
  }>(
    `
    SELECT m.id,
           m.sent_at,
           COALESCE(p.display_name, 'Unknown') AS sender,
           concat_ws(' — ',
             NULLIF(trim(m.text_content), ''),
             NULLIF(trim(a.description), ''),
             NULLIF(trim(t.transcript), '')
           ) AS content
    FROM messages m
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      ${EXCLUDE_SUMMARY_COMMAND}
      AND concat_ws(' — ',
            NULLIF(trim(m.text_content), ''),
            NULLIF(trim(a.description), ''),
            NULLIF(trim(t.transcript), '')
          ) <> ''
      AND (m.sent_at > $2 OR (m.sent_at = $2 AND m.id > $3))
    ORDER BY m.sent_at ASC, m.id ASC
    `,
    [groupId, cursor.sentAt, cursor.messageId],
  );

  return rows.map((r) => ({
    sentAt: r.sent_at,
    sender: r.sender,
    content: r.content,
    messageId: Number(r.id),
  }));
}

/**
 * The catch-up barrier: the `(sent_at, id)` cursor of the OLDEST voice note
 * after `cursor` that does not yet have a *completed* transcript, or null if
 * none. A failed transcript still counts as pending (its content may yet
 * arrive on retry), so "pending" = "no completed transcript", which is broader
 * than the transcription queue's "no transcript row at all".
 *
 * Reuses the canonical voice-note definition (AUDIO_PREDICATE + present media):
 * a non-present voice note will never produce content, so it is intentionally
 * NOT treated as a barrier — otherwise it would freeze the watermark forever.
 *
 * `staleBefore` is the never-freeze grace cutoff: a voice note sent at or before
 * it no longer acts as a barrier (its transcript is overdue and may never
 * arrive, so it must not hold catch-up hostage). null = no cutoff (no bound).
 */
export async function firstPendingVoiceNoteAfter(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  cursor: Cursor,
  staleBefore: Date | null = null,
): Promise<Cursor | null> {
  const { rows } = await client.query<{ id: string; sent_at: Date }>(
    `
    SELECT m.id, m.sent_at
    FROM messages m
    WHERE m.group_id = $1
      AND m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND ${AUDIO_PREDICATE}
      AND NOT EXISTS (
        SELECT 1 FROM transcripts t
        WHERE t.message_id = m.id AND t.status = 'completed'
      )
      AND (m.sent_at > $2 OR (m.sent_at = $2 AND m.id > $3))
      AND ($4::timestamptz IS NULL OR m.sent_at > $4)
    ORDER BY m.sent_at ASC, m.id ASC
    LIMIT 1
    `,
    [groupId, cursor.sentAt, cursor.messageId, staleBefore],
  );

  if (rows.length === 0) return null;
  return { sentAt: rows[0]!.sent_at, messageId: Number(rows[0]!.id) };
}

/**
 * The catch-up barrier for visual media: the `(sent_at, id)` cursor of the
 * OLDEST present image or video after `cursor` that does not yet have ANY
 * media_analyses row (neither completed nor failed), or null if none.
 *
 * Semantics differ subtly from the voice-note barrier:
 *   - Voice-note barrier: blocks on "no *completed* transcript" (a failed
 *     transcript still blocks because content may arrive on retry).
 *   - Visual-media barrier: blocks on "no media_analyses row at all". A
 *     *failed* analysis row means analysis was attempted and definitively
 *     failed; we must NOT block on it — otherwise a persistently failing image
 *     would freeze catch-up forever. So the NOT EXISTS checks for ANY
 *     media_analyses row (any status), not just completed ones.
 *
 * Only present media (media_status = 'present' AND media_path IS NOT NULL) is
 * considered: missing media will never produce content, so it intentionally
 * does NOT act as a barrier.
 *
 * Stickers (media_filename ILIKE 'STK-%') are excluded: they are never
 * analyzed and must not block catch-up.
 *
 * `staleBefore` is the never-freeze grace cutoff: an image/video sent at or
 * before it no longer acts as a barrier. Analysis is enqueued *selectively*, so
 * "no media_analyses row" often means analysis will never run — without this
 * cutoff such an item would freeze catch-up forever. null = no cutoff (no bound).
 */
export async function firstPendingVisualMediaAfter(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  cursor: Cursor,
  staleBefore: Date | null = null,
): Promise<Cursor | null> {
  const { rows } = await client.query<{ id: string; sent_at: Date }>(
    `
    SELECT m.id, m.sent_at
    FROM messages m
    WHERE m.group_id = $1
      AND m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND (${IMAGE_PREDICATE} OR ${VIDEO_PREDICATE})
      AND m.media_filename NOT ILIKE 'STK-%'
      AND NOT EXISTS (
        SELECT 1 FROM media_analyses a
        WHERE a.message_id = m.id
      )
      AND (m.sent_at > $2 OR (m.sent_at = $2 AND m.id > $3))
      AND ($4::timestamptz IS NULL OR m.sent_at > $4)
    ORDER BY m.sent_at ASC, m.id ASC
    LIMIT 1
    `,
    [groupId, cursor.sentAt, cursor.messageId, staleBefore],
  );

  if (rows.length === 0) return null;
  return { sentAt: rows[0]!.sent_at, messageId: Number(rows[0]!.id) };
}
