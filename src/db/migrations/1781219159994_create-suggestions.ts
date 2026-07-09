import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Suggestion engine (S6): the typed-suggestion layer + feedback log, both
 * tenant-scoped + RLS-forced (mirrors migration 031). Additive on top of the
 * existing total_summaries aggregate.
 *
 *   suggestions          — one row per generated suggestion (task/meeting/followup/
 *     recap), linked to the total_summaries it was extracted from. The day's deck =
 *     the pending rows, scope-filtered + capped. status lifecycle:
 *     pending → accepted | edited | snoozed | discarded.
 *   suggestion_feedback  — append-only decision log, decoupled so the per-(kind,chat)
 *     bias survives deck pruning and reset-learning is a single DELETE.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE suggestions (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      total_summary_id bigint NOT NULL REFERENCES total_summaries(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('task','meeting','followup','recap')),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      proposed_text text NOT NULL,
      reason text NOT NULL,
      source_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','edited','snoozed','discarded')),
      final_text text,
      snoozed_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      decided_at timestamptz
    );
    CREATE INDEX suggestions_deck_idx ON suggestions (tenant_id, status, created_at);
    CREATE INDEX suggestions_bias_idx ON suggestions (tenant_id, kind, group_id);

    CREATE TABLE suggestion_feedback (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      suggestion_id bigint NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
      kind text NOT NULL,
      group_id bigint NOT NULL,
      decision text NOT NULL CHECK (decision IN ('accepted','edited','snoozed','discarded')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX suggestion_feedback_bias_idx
      ON suggestion_feedback (tenant_id, kind, group_id, decision);
  `);

  for (const table of ["suggestions", "suggestion_feedback"]) {
    pgm.sql(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = ${HARDENED_GUC})
        WITH CHECK (tenant_id = ${HARDENED_GUC});
    `);
  }
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS suggestion_feedback;
    DROP TABLE IF EXISTS suggestions;
  `);
};
