import type { MigrationBuilder } from "node-pg-migrate";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Per-user /סיכום marks: each participant who runs the command in a group has
 * their own "last summarized" cursor, so the reply covers what THEY missed since
 * they last asked — independent of other askers. Also remembers the user's last
 * reply (summary + WhatsApp message id) so their sums chain into their own
 * thread across a collector restart. Tenant-scoped + RLS-forced, mirroring the
 * `people`/`read_watermarks` pattern.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE summary_user_marks (
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      participant_id bigint NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      last_summarized_at timestamptz NOT NULL,
      last_summary_id bigint REFERENCES summaries(id) ON DELETE SET NULL,
      last_reply_wa_message_id text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, group_id, participant_id)
    );

    ALTER TABLE summary_user_marks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE summary_user_marks FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON summary_user_marks
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS summary_user_marks");
};
