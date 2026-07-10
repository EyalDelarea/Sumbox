import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Drop row-level security. Sumbox is single-user and local-only, so there is no second
 * tenant to isolate from.
 *
 * RLS was already inert at runtime: the app connects as the owner/superuser, which
 * bypasses the policies. What made it dangerous to keep was the coupling — the policies
 * key off the per-transaction `app.tenant_id` GUC, and `withTenant()` (now removed) was
 * the only thing that ever set it. Left in place, a contributor connecting as a
 * non-superuser role would hit `tenant_id = NULL` and silently see zero rows.
 *
 * The `tenant_id` columns and their `COALESCE(GUC, default)` defaults stay, so writes
 * keep landing on the default tenant with the GUC unset. Only the policies go.
 *
 * Driven off the catalog rather than a hand-maintained table list: 21 migrations each
 * installed their own policy, and a literal list here would be one more thing to drift.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public'
      LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
      END LOOP;

      FOR r IN
        SELECT n.nspname AS schemaname, c.relname AS tablename
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      LOOP
        EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', r.schemaname, r.tablename);
        EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
      END LOOP;
    END $$;
  `);
};

/**
 * Restore ENABLE + FORCE RLS and the tenant_isolation policy on every table carrying a
 * `tenant_id` column. `audit_log` is excluded: it is deliberately global and never had
 * RLS. The policy uses the hardened GUC read (NULLIF on empty string) that migrations
 * 031 and harden-tenant-guc-new-tables established as the final form.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND c.column_name = 'tenant_id'
           AND t.table_type = 'BASE TABLE'
           AND c.table_name <> 'audit_log'
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON public.%I'
          ' USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)'
          ' WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
          r.table_name);
      END LOOP;
    END $$;
  `);
};
