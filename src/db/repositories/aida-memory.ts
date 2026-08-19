/**
 * aida-memory.ts — the write side of @Aida's per-group memory (shadow phase).
 *
 * The extractor is an LLM, so it is untrusted input. Rather than validate its
 * output in TypeScript and hope every caller remembers to, the insert DERIVES
 * every trust-bearing field from the cited message itself:
 *
 *   group_id, speaker_participant_id, observed_at  ←  messages.<row>
 *
 * NOTE on how strong that is: the NOT NULL columns are structural — no writer can
 * evade them. The speaker-equals-sender rule is NOT; it holds because this is the
 * only writer, and a future backfill script issuing its own INSERT could break it.
 * If a second writer ever appears, this belongs in a trigger.
 *
 * A caller therefore cannot say "Alex said X" about a message Royi wrote, cannot
 * attach a memory to a different group, and cannot invent a timestamp. The only
 * thing it supplies is the content and which message it came from — and if that
 * message is not in the group, the INSERT ... SELECT matches no rows and writes
 * nothing.
 *
 * Nothing reads these rows yet (D3: one week shadow).
 */
import { createHash } from "node:crypto";
import type pg from "pg";

/** Normalized so trivial whitespace differences don't defeat the dedupe. */
export function observationHash(content: string): string {
  return createHash("md5").update(content.trim().replace(/\s+/g, " ")).digest("hex");
}

export type ObservationInput = {
  /** The group the memory belongs to — also checked against the message's group. */
  groupId: number;
  /** The citation. Must be a message in `groupId`, or nothing is written. */
  sourceMessageId: number;
  /** What was observed, phrased as an attributed statement. */
  content: string;
};

/**
 * Record one attributed observation. Returns the new row id, or `null` when the
 * write was rejected or deduped.
 *
 * `null` is a normal outcome, not an error: the cited message may belong to
 * another group (a hallucinated id), may have no resolvable sender, or the same
 * observation may already exist from a previous extraction run over the same
 * window. Callers count these rather than retrying — the reject rate is the
 * signal for whether the extractor is any good.
 */
export async function recordObservation(
  client: pg.Pool | pg.PoolClient,
  input: ObservationInput,
): Promise<number | null> {
  const content = input.content.trim();
  if (content.length === 0) return null;
  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO aida_observations
      (group_id, speaker_participant_id, source_message_id, content, content_hash, observed_at)
    SELECT m.group_id, m.participant_id, m.id, $3, $4, m.sent_at
    FROM messages m
    WHERE m.id = $2
      AND m.group_id = $1
      AND m.participant_id IS NOT NULL
    ON CONFLICT ON CONSTRAINT aida_observations_dedupe DO NOTHING
    RETURNING id
    `,
    [input.groupId, input.sourceMessageId, content, observationHash(content)],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export type StoredObservation = {
  id: number;
  groupId: number;
  speaker: string;
  content: string;
  sourceMessageId: number;
  observedAt: Date;
};

/**
 * Live (non-revoked) observations for a group, newest first.
 *
 * Group-scoped by construction, exactly like every retrieval query — memory
 * inherits the privacy boundary rather than re-deciding it. Used by the review
 * CLI during shadow; the answer path does not call this yet.
 */
export async function listObservations(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  limit = 100,
): Promise<StoredObservation[]> {
  const { rows } = await client.query<{
    id: string;
    group_id: string;
    speaker: string | null;
    content: string;
    source_message_id: string;
    observed_at: Date;
  }>(
    `
    SELECT o.id, o.group_id, p.display_name AS speaker, o.content,
           o.source_message_id, o.observed_at
    FROM aida_observations o
    JOIN participants p ON p.id = o.speaker_participant_id
    WHERE o.group_id = $1 AND o.revoked_at IS NULL
    ORDER BY o.observed_at DESC, o.id DESC
    LIMIT $2
    `,
    [groupId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    groupId: Number(r.group_id),
    speaker: r.speaker ?? "",
    content: r.content,
    sourceMessageId: Number(r.source_message_id),
    observedAt: r.observed_at,
  }));
}

/**
 * Tombstone an observation. Append-only: the row and its citation survive, so a
 * revocation is auditable and a bad extraction run can be undone wholesale
 * without losing the record that it happened.
 *
 * `groupId` is optional but should be passed by anything acting on behalf of a
 * group (the chat-revoke path in slice 2, above all): every other query in this
 * module carries the group boundary, and a revoke that does not is the one place
 * an id from another chat could take effect.
 */
export async function revokeObservation(
  client: pg.Pool | pg.PoolClient,
  id: number,
  opts: { groupId?: number; byParticipantId?: number } = {},
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE aida_observations
        SET revoked_at = now(), revoked_by_participant_id = $2
      WHERE id = $1 AND revoked_at IS NULL
        AND ($3::bigint IS NULL OR group_id = $3)`,
    [id, opts.byParticipantId ?? null, opts.groupId ?? null],
  );
  return (rowCount ?? 0) > 0;
}
