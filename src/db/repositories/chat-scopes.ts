import type pg from "pg";

/** A group with its scope state, for the Sources screen / onboarding picker. */
export type ScopeRow = {
  group: string;
  source: string;
  messageCount: number;
  lastMessageAt: Date | null;
  included: boolean;
  categoryId: number | null;
  removed: boolean;
  /** Muted chats stay in catch-up/Updates but generate no proactive suggestions. */
  muted: boolean;
};

/** A single scope change (one chat). `removed` true→soft-remove, false→restore. */
export type ScopeUpdate = {
  groupId: number;
  included?: boolean;
  categoryId?: number | null;
  removed?: boolean;
  muted?: boolean;
};

/**
 * All groups LEFT-JOINed to their scope. A group with no chat_scopes row reports
 * `included: false, categoryId: null, removed: false` — the default-OFF rule:
 * nothing is summarized until the user explicitly includes it.
 */
export async function listScopes(client: pg.Pool | pg.PoolClient): Promise<ScopeRow[]> {
  const { rows } = await client.query<{
    name: string;
    source: string;
    message_count: string;
    last_message_at: Date | null;
    included: boolean;
    category_id: string | null;
    removed: boolean;
    muted: boolean;
  }>(
    `
    SELECT g.name,
           g.source,
           COUNT(m.id) AS message_count,
           MAX(m.sent_at) AS last_message_at,
           COALESCE(cs.included, false) AS included,
           cs.category_id,
           (cs.removed_at IS NOT NULL) AS removed,
           COALESCE(cs.muted, false) AS muted
    FROM groups g
    LEFT JOIN chat_scopes cs ON cs.group_id = g.id
    LEFT JOIN messages m ON m.group_id = g.id
    GROUP BY g.id, g.name, g.source, cs.included, cs.category_id, cs.removed_at, cs.muted
    ORDER BY last_message_at DESC NULLS LAST, g.name ASC
    `,
  );
  return rows.map((r) => ({
    group: r.name,
    source: r.source,
    messageCount: Number(r.message_count),
    lastMessageAt: r.last_message_at ?? null,
    included: r.included,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    removed: r.removed,
    muted: r.muted,
  }));
}

/**
 * Upsert one chat's scope. Only the provided fields are written; the rest keep
 * their stored values (or column defaults on first insert). `removed:true` sets
 * `removed_at = now()`, `removed:false` clears it (restore).
 */
export async function upsertScope(
  client: pg.Pool | pg.PoolClient,
  update: ScopeUpdate,
): Promise<void> {
  const cols = ["group_id"];
  const vals = ["$1"];
  const sets: string[] = [];
  const params: unknown[] = [update.groupId];

  if (update.included !== undefined) {
    params.push(update.included);
    cols.push("included");
    vals.push(`$${params.length}`);
    sets.push("included = EXCLUDED.included");
  }
  if (update.categoryId !== undefined) {
    params.push(update.categoryId);
    cols.push("category_id");
    vals.push(`$${params.length}`);
    sets.push("category_id = EXCLUDED.category_id");
  }
  if (update.removed !== undefined) {
    const expr = update.removed ? "now()" : "NULL";
    cols.push("removed_at");
    vals.push(expr);
    sets.push(`removed_at = ${expr}`);
  }
  if (update.muted !== undefined) {
    params.push(update.muted);
    cols.push("muted");
    vals.push(`$${params.length}`);
    sets.push("muted = EXCLUDED.muted");
  }
  sets.push("updated_at = now()");

  await client.query(
    `INSERT INTO chat_scopes (${cols.join(", ")})
     VALUES (${vals.join(", ")})
     ON CONFLICT (tenant_id, group_id) DO UPDATE SET ${sets.join(", ")}`,
    params,
  );
}

/** Apply a batch of scope updates (onboarding "continue" + Sources bulk toggles). */
export async function upsertScopes(
  client: pg.Pool | pg.PoolClient,
  updates: ScopeUpdate[],
): Promise<void> {
  for (const update of updates) await upsertScope(client, update);
}

/**
 * The digest filter: group ids that should be summarized. Default-OFF — only a
 * group with an explicit `included = true` row (and no `removed_at`) qualifies;
 * an unscoped group is excluded until the user opts it in.
 */
export async function listIncludedGroupIds(client: pg.Pool | pg.PoolClient): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(
    `
    SELECT g.id
    FROM groups g
    JOIN chat_scopes cs ON cs.group_id = g.id
    WHERE cs.included AND cs.removed_at IS NULL
    ORDER BY g.id ASC
    `,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Point-lookup: returns true when the given group has an active scope row with
 * `included = true` (`removed_at IS NULL`). An unscoped group returns false
 * (the same default-OFF rule as `listIncludedGroupIds`).
 *
 * Used by the media pipeline to gate analysis enqueues on chat selection without
 * loading the full list.
 */
export async function isGroupIncluded(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<boolean> {
  const { rows } = await client.query<{ included: boolean }>(
    `SELECT cs.included
       FROM chat_scopes cs
      WHERE cs.group_id = $1 AND cs.removed_at IS NULL`,
    [groupId],
  );
  return rows[0]?.included ?? false;
}

/**
 * The user-assigned category NAME for a group (e.g. "עבודה", "משפחה"), or null
 * when the chat is uncategorized. Orients the agent on the chat's nature/tone.
 */
export async function getGroupCategoryName(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<string | null> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT sc.name
       FROM chat_scopes cs
       JOIN scope_categories sc ON sc.id = cs.category_id
      WHERE cs.group_id = $1 AND cs.removed_at IS NULL`,
    [groupId],
  );
  return rows[0]?.name ?? null;
}

/**
 * The suggestion filter: included group ids that are NOT muted. Muted chats are
 * still summarized (they stay in `listIncludedGroupIds`) but produce no proactive
 * suggestions — the §7 "third state". A strict subset of `listIncludedGroupIds`.
 */
export async function listSuggestibleGroupIds(client: pg.Pool | pg.PoolClient): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(
    `
    SELECT g.id
    FROM groups g
    JOIN chat_scopes cs ON cs.group_id = g.id
    WHERE cs.included AND cs.removed_at IS NULL AND NOT cs.muted
    ORDER BY g.id ASC
    `,
  );
  return rows.map((r) => Number(r.id));
}
