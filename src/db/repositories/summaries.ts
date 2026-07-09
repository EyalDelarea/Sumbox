import type pg from "pg";
import type { SummaryOutput } from "../../summarization/summarizer.js";

/** 👍/👎 feedback rating. */
export type Rating = 1 | -1;

export type InsertSummaryInput = {
  groupId: number;
  summaryType: "last_n" | "since" | "watermark";
  parameters: Record<string, unknown>;
  output: SummaryOutput;
  model: string;
  /** When set, this row is a regeneration of summaries.id = regeneratedFromId. */
  regeneratedFromId?: number | null;
};

/**
 * Returns the most recent catch-up (summary_type='watermark') summary for a
 * group, or null when none exists. Used by prepareSumbox to serve the cache.
 *
 * Returns the FULL structured `output` (not just `overview`) so the cache-hit
 * path can re-render the same structured §3 card a fresh summary would — see
 * `normalizeSummaryOutput`. Flattening to the overview string here is what made
 * "מה שפספסתי" fall back to the old markdown card on a cache hit.
 */
export async function getLatestSumboxSummary(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<{ id: number; output: SummaryOutput; createdAt: Date } | null> {
  const { rows } = await client.query<{ id: string; output: SummaryOutput; created_at: Date }>(
    `
    SELECT id, output, created_at
    FROM summaries
    WHERE group_id = $1
      AND summary_type = 'watermark'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [groupId],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { id: Number(row.id), output: row.output, createdAt: row.created_at };
}

export type SummaryRow = {
  id: number;
  summaryType: string;
  parameters: Record<string, unknown>;
  output: SummaryOutput;
  model: string;
  createdAt: Date;
};

/**
 * Returns summaries for a group, newest-first, limited to `limit` rows.
 */
export async function listSummariesByGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  limit: number,
): Promise<SummaryRow[]> {
  const { rows } = await client.query<{
    id: string;
    summary_type: string;
    parameters: Record<string, unknown>;
    output: SummaryOutput;
    model: string;
    created_at: Date;
  }>(
    `
    SELECT id, summary_type, parameters, output, model, created_at
    FROM summaries
    WHERE group_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
    `,
    [groupId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    summaryType: row.summary_type,
    parameters: row.parameters,
    output: row.output,
    model: row.model,
    createdAt: row.created_at,
  }));
}

/** Persist a generated summary; returns the new row id (FR-018). */
export async function insertSummary(
  client: pg.Pool | pg.PoolClient,
  input: InsertSummaryInput,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO summaries (group_id, summary_type, parameters, output, model, regenerated_from_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
    `,
    [
      input.groupId,
      input.summaryType,
      JSON.stringify(input.parameters),
      JSON.stringify(input.output),
      input.model,
      input.regeneratedFromId ?? null,
    ],
  );
  return Number(rows[0].id);
}

/** Persist a 👍/👎 (+optional reason code) on a summary. Returns false for an unknown id. */
export async function setSummaryRating(
  client: pg.Pool | pg.PoolClient,
  id: number,
  rating: Rating | null,
  reason: string | null,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE summaries SET rating = $2, rating_reason = $3 WHERE id = $1`,
    [id, rating, reason],
  );
  return (rowCount ?? 0) > 0;
}

/** Read a single summary's structured output by id (for rebuilding a quote preview). */
export async function getSummaryOutputById(
  client: pg.Pool | pg.PoolClient,
  id: number,
): Promise<SummaryOutput | null> {
  const { rows } = await client.query<{ output: SummaryOutput }>(
    `SELECT output FROM summaries WHERE id = $1`,
    [id],
  );
  return rows[0]?.output ?? null;
}

/** Read the fields the regenerate path needs to replay a summary's message range. */
export async function getSummaryForRegenerate(
  client: pg.Pool | pg.PoolClient,
  id: number,
): Promise<{ id: number; groupId: number; parameters: Record<string, unknown> } | null> {
  const { rows } = await client.query<{
    id: string;
    group_id: string;
    parameters: Record<string, unknown>;
  }>(
    `SELECT id, group_id, parameters FROM summaries WHERE id = $1 AND summary_type = 'watermark'`,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { id: Number(row.id), groupId: Number(row.group_id), parameters: row.parameters };
}
