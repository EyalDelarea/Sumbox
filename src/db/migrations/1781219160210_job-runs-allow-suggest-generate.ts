import type { MigrationBuilder } from "node-pg-migrate";

// S6 adds the suggest.generate job type (typed-suggestion extraction, chained
// off the daily total summary); the job_runs.type CHECK must permit it or the
// job-run recorder rejects every enqueue. Mirrors migration 019.
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video', 'summarize.group', 'summarize.total', 'suggest.generate'));
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video', 'summarize.group', 'summarize.total'));
  `);
};
