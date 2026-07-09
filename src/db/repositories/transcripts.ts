import type pg from "pg";

export type PendingVoiceNote = {
  messageId: number;
  mediaPath: string;
};

export type InsertTranscriptInput = {
  messageId: number;
  transcript: string | null;
  engine: string;
  status: "completed" | "failed";
  errorMessage?: string | null;
  language?: string;
};

// Audio extensions we attempt to transcribe (WhatsApp voice notes are .opus).
// Exported so the catch-up barrier (firstPendingVoiceNoteAfter) reuses the exact
// same voice-note definition rather than re-deriving it.
export const AUDIO_PREDICATE = `(
  lower(m.media_filename) LIKE '%.opus' OR
  lower(m.media_filename) LIKE '%.ogg'  OR
  lower(m.media_filename) LIKE '%.m4a'  OR
  lower(m.media_filename) LIKE '%.mp3'  OR
  lower(m.media_filename) LIKE '%.wav'  OR
  lower(m.media_filename) LIKE '%.aac'
)`;

function groupFilter(groupName: string | undefined, params: unknown[]): string {
  if (groupName === undefined) return "";
  params.push(groupName);
  return `AND g.name = $${params.length}`;
}

/** Media messages that are audio, present on disk, and not yet transcribed. */
export async function selectPendingVoiceNotes(
  client: pg.Pool | pg.PoolClient,
  groupName?: string,
): Promise<PendingVoiceNote[]> {
  const params: unknown[] = [];
  const filter = groupFilter(groupName, params);
  const { rows } = await client.query<{ id: string; media_path: string }>(
    `
    SELECT m.id, m.media_path
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    LEFT JOIN transcripts t ON t.message_id = m.id
    WHERE m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND ${AUDIO_PREDICATE}
      AND t.id IS NULL
      ${filter}
    ORDER BY m.sent_at ASC
    `,
    params,
  );
  return rows.map((r) => ({ messageId: Number(r.id), mediaPath: r.media_path }));
}

/** Count of audio media messages that already have a transcript (any status). */
export async function countTranscribedVoiceNotes(
  client: pg.Pool | pg.PoolClient,
  groupName?: string,
): Promise<number> {
  const params: unknown[] = [];
  const filter = groupFilter(groupName, params);
  const { rows } = await client.query<{ cnt: string }>(
    `
    SELECT COUNT(*) AS cnt
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    JOIN transcripts t ON t.message_id = m.id
    WHERE m.message_type = 'media'
      AND ${AUDIO_PREDICATE}
      ${filter}
    `,
    params,
  );
  return Number(rows[0].cnt);
}

/**
 * Returns message IDs (as strings) for audio voice notes in the given group
 * that have not yet been transcribed. Used by the import-file worker handler
 * to enqueue transcribe.voicenote jobs after an import completes.
 *
 * Mirrors the selection logic in selectPendingVoiceNotes but scoped by group
 * name and returning string IDs for the job bus payload.
 */
export async function listUntranscribedVoiceNoteIdsByGroup(
  client: pg.Pool | pg.PoolClient,
  groupName: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `
    SELECT m.id::text
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    LEFT JOIN transcripts t ON t.message_id = m.id
    WHERE m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND ${AUDIO_PREDICATE}
      AND g.name = $1
      AND t.id IS NULL
    ORDER BY m.sent_at ASC
    `,
    [groupName],
  );
  return rows.map((r) => r.id);
}

/**
 * Returns the media_path for a voice note message if it exists, is present on
 * disk, and is an audio file. Returns null if the message does not exist, is
 * not a media message, or has no media path.
 *
 * Used by the transcribe.voicenote worker handler to look up the file path for
 * a single job before calling the transcriber.
 */
export async function getVoiceNoteMediaPath(
  client: pg.Pool | pg.PoolClient,
  messageId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ media_path: string }>(
    `
    SELECT m.media_path
    FROM messages m
    WHERE m.id = $1
      AND m.message_type = 'media'
      AND m.media_status = 'present'
      AND m.media_path IS NOT NULL
      AND ${AUDIO_PREDICATE}
    `,
    [messageId],
  );
  return rows[0]?.media_path ?? null;
}

/**
 * Returns true if a transcript row already exists for the given messageId
 * (any status). Used by the transcribe.voicenote handler for idempotency.
 */
export async function hasTranscript(
  client: pg.Pool | pg.PoolClient,
  messageId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM transcripts WHERE message_id = $1`,
    [messageId],
  );
  return Number(rows[0].cnt) > 0;
}

/** Insert a transcript row; idempotent via ON CONFLICT (message_id) DO NOTHING (FR-012). */
export async function insertTranscript(
  client: pg.Pool | pg.PoolClient,
  input: InsertTranscriptInput,
): Promise<void> {
  await client.query(
    `
    INSERT INTO transcripts (message_id, transcript, language, engine, status, error_message)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (message_id) DO NOTHING
    `,
    [
      input.messageId,
      input.transcript,
      input.language ?? "he",
      input.engine,
      input.status,
      input.errorMessage ?? null,
    ],
  );
}
