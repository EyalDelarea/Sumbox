import type { MigrationBuilder } from "node-pg-migrate";

// Feature 007 adds analyze.image / analyze.video job types; the job_runs.type CHECK
// must permit them or the job-run recorder fails on every media job.
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video'));
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote'));
  `);
};
