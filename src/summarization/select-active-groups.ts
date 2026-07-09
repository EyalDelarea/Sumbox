import type pg from "pg";

export type ActiveGroup = { id: number; name: string };

/**
 * All chats (group chats AND DMs — the `groups` table holds both) that have at
 * least one content-bearing, non-system message on/after `since`. Uses the same
 * transcript/media content predicate as selectMessages so "active" matches what
 * would actually be summarized. Ordered by name for stable display.
 *
 * Scope-filtered (S4, default-OFF): only a chat with an explicit `included = true`
 * row (and no `removed_at`) is summarized; a chat with no scope row is excluded
 * until the user opts it in.
 */
export async function selectActiveGroups(
  client: pg.Pool | pg.PoolClient,
  range: { since: Date },
): Promise<ActiveGroup[]> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `
    SELECT g.id, g.name
    FROM groups g
    JOIN messages m ON m.group_id = g.id
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
    WHERE m.message_type <> 'system'
      AND m.sent_at >= $1
      AND concat_ws(' — ',
            NULLIF(trim(m.text_content), ''),
            NULLIF(trim(a.description), ''),
            NULLIF(trim(t.transcript), '')
          ) <> ''
      AND EXISTS (
        SELECT 1 FROM chat_scopes cs
        WHERE cs.group_id = g.id AND cs.included AND cs.removed_at IS NULL
      )
    GROUP BY g.id, g.name
    ORDER BY g.name ASC
    `,
    [range.since],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}
