import type pg from "pg";

/** Saved preferences. A missing row resolves to env defaults at the caller. */
export type UserPreferences = {
  /** CSV HH:MM (same grammar as DIGEST_TIMES). */
  digestTimes: string;
  morningNotification: boolean;
  /** RESERVED for the S6 engine; S5 round-trips it opaquely. */
  engineConfig: Record<string, unknown>;
  /** nullable — the S1 client localStorage stays the source of truth. */
  theme: string | null;
  /**
   * Auto-purge window for unselected chats, in days. NULL = retention OFF (nothing
   * auto-deletes) — the zero-config default.
   */
  retentionDays: number | null;
  /** The in-group trigger, e.g. "/סיכום". NULL ⇒ DEFAULT_SUMMARY_TRIGGER. */
  summaryCommandTrigger: string | null;
};

type Row = {
  digest_times: string;
  morning_notification: boolean;
  engine_config: Record<string, unknown>;
  theme: string | null;
  retention_days: number | null;
  summary_command_trigger: string | null;
};

function mapRow(r: Row): UserPreferences {
  return {
    digestTimes: r.digest_times,
    morningNotification: r.morning_notification,
    engineConfig: r.engine_config ?? {},
    theme: r.theme ?? null,
    retentionDays: r.retention_days ?? null,
    summaryCommandTrigger: r.summary_command_trigger ?? null,
  };
}

/** The saved preferences row, or null when none has been saved yet. */
export async function getPreferences(
  client: pg.Pool | pg.PoolClient,
): Promise<UserPreferences | null> {
  const { rows } = await client.query<Row>(
    `SELECT digest_times, morning_notification, engine_config, theme, retention_days, summary_command_trigger
       FROM user_preferences LIMIT 1`,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Upsert the current tenant's preferences (one row, keyed by the tenant_id PK
 * default). Only the provided fields are written; the rest keep their stored
 * values or column defaults on first insert. Returns the resulting row.
 */
export async function upsertPreferences(
  client: pg.Pool | pg.PoolClient,
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const cols: string[] = [];
  const vals: string[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];

  const add = (col: string, value: unknown) => {
    params.push(value);
    cols.push(col);
    vals.push(`$${params.length}`);
    sets.push(`${col} = EXCLUDED.${col}`);
  };
  if (patch.digestTimes !== undefined) add("digest_times", patch.digestTimes);
  if (patch.morningNotification !== undefined)
    add("morning_notification", patch.morningNotification);
  if (patch.engineConfig !== undefined) add("engine_config", JSON.stringify(patch.engineConfig));
  if (patch.theme !== undefined) add("theme", patch.theme);
  if (patch.retentionDays !== undefined) add("retention_days", patch.retentionDays);
  sets.push("updated_at = now()");

  // With no fields provided, still ensure a row exists (defaults).
  const insert = cols.length
    ? `INSERT INTO user_preferences (${cols.join(", ")}) VALUES (${vals.join(", ")})`
    : `INSERT INTO user_preferences DEFAULT VALUES`;

  const { rows } = await client.query<Row>(
    `${insert}
     ON CONFLICT (tenant_id) DO UPDATE SET ${sets.join(", ")}
     RETURNING digest_times, morning_notification, engine_config, theme, retention_days, summary_command_trigger`,
    params,
  );
  return mapRow(rows[0]!);
}

/** The shipped default. A NULL column resolves to this. */
export const DEFAULT_SUMMARY_TRIGGER = "/סיכום";

/**
 * Validation is here, not at the HTTP edge, because the trigger is compared against
 * live inbound message bodies. A trigger of "" would match every blank message; a
 * trigger without a leading slash would fire on ordinary conversation.
 */
export async function setSummaryCommandTrigger(
  client: pg.Pool | pg.PoolClient,
  trigger: string,
): Promise<void> {
  const t = trigger.trim();
  if (!t.startsWith("/") || t.length < 2 || t.length > 32 || /\s/.test(t)) {
    throw new Error(`Invalid summary command trigger: ${JSON.stringify(trigger)}`);
  }
  await client.query(
    `INSERT INTO user_preferences (summary_command_trigger) VALUES ($1)
     ON CONFLICT (tenant_id) DO UPDATE SET summary_command_trigger = $1`,
    [t],
  );
}
