/**
 * corpus.ts — the questions people actually asked, as an evaluable set.
 *
 * The golden set has 6–8 items because every one needs a hand-labeled
 * `goldExternalIds`. That labelling cost is why the corpus stayed tiny, and a
 * tiny corpus is why its noise floor (±0.17) swallows most real effects.
 *
 * Meanwhile `aida_messages` has been recording every question put to her since
 * 2026-07-16 — 219 of them across 6 groups, each with the group it was asked in
 * and the moment it was asked. Paired with the label-free metrics, that is a
 * corpus twenty times larger that needs no labelling at all.
 *
 * `asOf` is the load-bearing field: it is the question's OWN timestamp, so a
 * replay reconstructs the recency window as it was, not as it is today. Without
 * it the corpus would silently drift as new messages arrive and two runs a week
 * apart would not be comparable.
 */
import type pg from "pg";

export type CorpusItem = {
  id: string;
  groupId: number;
  question: string;
  /** The question's own sent_at — pins the recency window for a faithful replay. */
  asOf: Date;
};

export type CorpusOpts = {
  /** Restrict to one group. Omitted: every group she has answered in. */
  groupId?: number;
  limit?: number;
};

/**
 * Build the corpus from real questions.
 *
 * Excludes empty questions (a bare `@אידה` mention with no text carries nothing
 * to replay) and de-duplicates on the question text within a group, so a probe
 * someone repeated eight times while testing does not get eight votes.
 */
export async function buildCorpus(
  client: pg.Pool | pg.PoolClient,
  opts: CorpusOpts = {},
): Promise<CorpusItem[]> {
  const { rows } = await client.query<{
    external_id: string;
    group_id: string;
    question: string;
    sent_at: Date;
  }>(
    `
    SELECT DISTINCT ON (a.group_id, btrim(a.question))
           a.external_id, a.group_id, a.question, a.sent_at
    FROM aida_messages a
    WHERE a.question IS NOT NULL
      AND btrim(a.question) <> ''
      AND ($1::bigint IS NULL OR a.group_id = $1)
    -- DISTINCT ON keeps the FIRST asking of a repeated question, which is the one
    -- whose window is uncontaminated by her own earlier answers to it.
    ORDER BY a.group_id, btrim(a.question), a.sent_at
    `,
    [opts.groupId ?? null],
  );

  const items = rows.map((r) => ({
    id: r.external_id,
    groupId: Number(r.group_id),
    question: r.question,
    asOf: r.sent_at,
  }));
  // Chronological, so a truncated run is still a coherent slice of history
  // rather than an arbitrary one.
  items.sort((a, b) => a.asOf.getTime() - b.asOf.getTime());
  return opts.limit ? items.slice(0, opts.limit) : items;
}
