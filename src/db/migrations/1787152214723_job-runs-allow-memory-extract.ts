import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Widen `job_runs_type_check` for `memory.extract` (@Aida's shadow-phase memory
 * extraction).
 *
 * Required alongside the JOB_DESCRIPTORS row — the constraint is the runtime
 * half of that table, and `src/jobs/job-runs-constraint.test.ts` fails CI if the
 * two drift.
 *
 * `suggest.generate` is carried forward: it is still in the constraint from
 * migration 1781219160210 even though the feature is gone, and dropping it here
 * would be an unrelated change riding along in a migration about something else.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video', 'summarize.group', 'summarize.total', 'suggest.generate', 'memory.extract'));
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video', 'summarize.group', 'summarize.total', 'suggest.generate'));
  `);
};
