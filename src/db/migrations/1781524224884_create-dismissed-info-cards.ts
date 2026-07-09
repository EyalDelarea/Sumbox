import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id (migration 022). Inlined, not imported —
// node-pg-migrate loads each migration via raw ESM resolution and cannot resolve
// cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// Hardened GUC read: NULLIF(..., '') treats the empty-string state that
// `SET LOCAL app.tenant_id` leaves behind after COMMIT as unset, so a pooled
// connection fails closed instead of erroring with `invalid input syntax for
// type uuid: ""`. New scoped tables must use this form from the start — see
// migration `harden-tenant-guc-new-tables` (it back-patched the two that didn't).
const HARDENED_GUC = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Records which Today info cards (the read-only chat summaries / cross-chat
 * "highlights" overview) a tenant has dismissed via "הבנתי".
 *
 * Keyed by `summary_id` (the `total_summaries` row the card was rendered from)
 * so a dismissal is scoped to that *version* of the digest: dismiss today's
 * summary and it stays gone, but the next generated digest is a new row with no
 * dismissal rows, so its cards surface again. `card_id` is the client-side card
 * identity (`info:highlights` or `info:chat:<chat>`). ON DELETE CASCADE prunes
 * dismissals when their summary is pruned.
 *
 * Tenant isolation follows the standard tenant_id + fail-closed RLS pattern
 * (migrations 023/025), using the hardened GUC expression.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE dismissed_info_cards (
      id bigserial PRIMARY KEY,
      summary_id bigint NOT NULL REFERENCES total_summaries(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(${HARDENED_GUC}, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      card_id text NOT NULL,
      dismissed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT dismissed_info_cards_unique UNIQUE (tenant_id, summary_id, card_id)
    );

    CREATE INDEX dismissed_info_cards_tenant_idx
      ON dismissed_info_cards (tenant_id, summary_id);
  `);

  // Tenant isolation — same fail-closed pattern as migration 025, hardened GUC.
  pgm.sql(`
    ALTER TABLE dismissed_info_cards ENABLE ROW LEVEL SECURITY;
    ALTER TABLE dismissed_info_cards FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON dismissed_info_cards
      USING (tenant_id = ${HARDENED_GUC})
      WITH CHECK (tenant_id = ${HARDENED_GUC});
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS dismissed_info_cards");
};
