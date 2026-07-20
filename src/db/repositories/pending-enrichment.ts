import type pg from "pg";
import { IMAGE_PREDICATE, VIDEO_PREDICATE } from "../../vision/media-kind.js";
import { AUDIO_PREDICATE } from "./transcripts.js";

/** Recent media messages whose enrichment hasn't completed. "Pending" is
 *  literally "no completed row WITH non-empty content" — media_analyses/
 *  transcripts only ever hold 'completed'/'failed', so absence IS the
 *  in-flight state, and a failed row stays pending because the sweep retries
 *  it. The non-empty check must stay in lockstep with CONTENT_EXPR
 *  (concat_ws of NULLIF(trim(...))) and with recent-window.ts's pending_kind
 *  CASE — otherwise the wait and the window can disagree about what counts
 *  as "still pending". */
export async function countPendingEnrichment(
  client: pg.Pool | pg.PoolClient,
  input: { groupId: number; since: Date; until: Date },
): Promise<number> {
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM messages m
      WHERE m.group_id = $1
        AND m.sent_at >= $2 AND m.sent_at <= $3
        AND m.message_type = 'media'
        AND m.media_status = 'present'
        AND (m.media_filename IS NULL OR m.media_filename NOT ILIKE 'STK-%')
        AND (
          ((${IMAGE_PREDICATE} OR ${VIDEO_PREDICATE})
            AND NOT EXISTS (SELECT 1 FROM media_analyses a
                             WHERE a.message_id = m.id AND a.status = 'completed'
                               AND NULLIF(trim(a.description), '') IS NOT NULL))
          OR (${AUDIO_PREDICATE}
            AND NOT EXISTS (SELECT 1 FROM transcripts t
                             WHERE t.message_id = m.id AND t.status = 'completed'
                               AND NULLIF(trim(t.transcript), '') IS NOT NULL))
        )`,
    [input.groupId, input.since, input.until],
  );
  return Number(rows[0].cnt);
}
