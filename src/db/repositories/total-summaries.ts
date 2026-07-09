import type pg from "pg";
import type { TotalSummaryOutput } from "../../summarization/total-types.js";

export type InsertTotalSummaryInput = {
  rangeKind: "since" | "scheduled";
  parameters: Record<string, unknown>;
  output: TotalSummaryOutput;
  model: string;
};

/** Persist a total summary; returns the new row id. */
export async function insertTotalSummary(
  client: pg.Pool | pg.PoolClient,
  input: InsertTotalSummaryInput,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO total_summaries (range_kind, parameters, output, model)
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
    [input.rangeKind, JSON.stringify(input.parameters), JSON.stringify(input.output), input.model],
  );
  return Number(rows[0]!.id);
}

export type TotalSummaryRow = {
  id: number;
  rangeKind: string;
  parameters: Record<string, unknown>;
  output: TotalSummaryOutput;
  model: string;
  createdAt: Date;
};

/** A single total summary by id, or null. Used by the S6 generation chain. */
export async function getTotalSummaryById(
  client: pg.Pool | pg.PoolClient,
  id: number,
): Promise<TotalSummaryRow | null> {
  const { rows } = await client.query<{
    id: string;
    range_kind: string;
    parameters: Record<string, unknown>;
    output: TotalSummaryOutput;
    model: string;
    created_at: Date;
  }>(
    `SELECT id, range_kind, parameters, output, model, created_at
     FROM total_summaries WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    rangeKind: r.range_kind,
    parameters: r.parameters,
    output: r.output,
    model: r.model,
    createdAt: r.created_at,
  };
}

/** Total summaries, newest-first, limited to `limit` rows. */
export async function listTotalSummaries(
  client: pg.Pool | pg.PoolClient,
  limit: number,
): Promise<TotalSummaryRow[]> {
  const { rows } = await client.query<{
    id: string;
    range_kind: string;
    parameters: Record<string, unknown>;
    output: TotalSummaryOutput;
    model: string;
    created_at: Date;
  }>(
    `
    SELECT id, range_kind, parameters, output, model, created_at
    FROM total_summaries
    ORDER BY created_at DESC, id DESC
    LIMIT $1
    `,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    rangeKind: r.range_kind,
    parameters: r.parameters,
    output: r.output,
    model: r.model,
    createdAt: r.created_at,
  }));
}
