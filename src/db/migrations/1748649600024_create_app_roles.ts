import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Create the application DB roles. RLS is bypassed by superusers and table owners,
 * so the app MUST connect as a dedicated non-superuser role for isolation to be real.
 *
 * - catchapp_app:      LOGIN, NOSUPERUSER, NOBYPASSRLS — the app runtime connects as this.
 * - catchapp_operator: LOGIN, NOSUPERUSER, BYPASSRLS   — cross-tenant admin (T5); unused in T1 runtime.
 *
 * Role creation is idempotent (roles are cluster-global; the suite migrates a template
 * DB once but standalone test DBs re-run migrations). The down migration only REVOKEs in
 * the current database — it does NOT drop the roles, because in a shared cluster other
 * databases (template clones) still depend on them.
 *
 * Passwords here are local/test defaults; real deployments override via the role's
 * own ALTER ROLE ... PASSWORD and APP_DATABASE_URL.
 */
export const APP_ROLE = "catchapp_app";
export const APP_ROLE_PASSWORD = "catchapp_app_local_pw";
export const OPERATOR_ROLE = "catchapp_operator";
export const OPERATOR_ROLE_PASSWORD = "catchapp_operator_local_pw";

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OPERATOR_ROLE}') THEN
        CREATE ROLE ${OPERATOR_ROLE} LOGIN PASSWORD '${OPERATOR_ROLE_PASSWORD}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;

    GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${OPERATOR_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}, ${OPERATOR_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}, ${OPERATOR_ROLE};

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}, ${OPERATOR_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}, ${OPERATOR_ROLE};
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  // Revoke privileges in THIS database only. Do not DROP the roles: they are
  // cluster-global and other databases in a shared test cluster depend on them.
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}, ${OPERATOR_ROLE};
    REVOKE USAGE ON SCHEMA public FROM ${APP_ROLE}, ${OPERATOR_ROLE};
  `);
};
