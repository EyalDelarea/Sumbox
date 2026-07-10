import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of migration 024's role names — inlined because node-pg-migrate cannot
// resolve cross-migration imports.
const APP_ROLE = "catchapp_app";
const OPERATOR_ROLE = "catchapp_operator";

/**
 * Revoke and lock the two RLS-era database roles.
 *
 * They existed only to make row-level security meaningful: `catchapp_app` was the
 * NOBYPASSRLS role the app connected as, `catchapp_operator` the BYPASSRLS role for
 * cross-tenant reads. Both connection paths are gone, and RLS is gone, so nothing
 * connects as either role.
 *
 * That combination is dangerous rather than merely dead. Both roles keep LOGIN and
 * `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`, and their passwords are
 * committed in migration 024. While RLS was enforced, `catchapp_app` was fail-closed
 * without the `app.tenant_id` GUC and saw zero rows; with RLS dropped it reads every
 * message body. Verified against a migrated throwaway database:
 *
 *   before:  SELECT count(*) FROM messages  ->  0   (as catchapp_app, no GUC)
 *   after:   SELECT count(*) FROM messages  ->  1
 *
 * NOLOGIN + REVOKE closes that. The roles are NOT dropped: DROP ROLE is cluster-global
 * and fails while grants linger in any database of the cluster — including the test
 * harness's template and its per-file clones. Migration 024's own `down` makes the same
 * call for the same reason.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    REVOKE USAGE ON SCHEMA public FROM ${APP_ROLE}, ${OPERATOR_ROLE};

    ALTER ROLE ${APP_ROLE} NOLOGIN;
    ALTER ROLE ${OPERATOR_ROLE} NOLOGIN;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER ROLE ${APP_ROLE} LOGIN;
    ALTER ROLE ${OPERATOR_ROLE} LOGIN;

    GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${OPERATOR_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}, ${OPERATOR_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}, ${OPERATOR_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}, ${OPERATOR_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}, ${OPERATOR_ROLE};
  `);
};
