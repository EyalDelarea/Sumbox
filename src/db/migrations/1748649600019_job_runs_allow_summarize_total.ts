import type { MigrationBuilder } from "node-pg-migrate";

// Total summary feature adds the summarize.total job type (scheduled aggregate
// digest); the job_runs.type CHECK must permit it or the job-run recorder
// rejects every total enqueue.
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video', 'summarize.group', 'summarize.total'));
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE job_runs
      DROP CONSTRAINT IF EXISTS job_runs_type_check,
      ADD CONSTRAINT job_runs_type_check
      CHECK (type IN ('import.file', 'transcribe.voicenote', 'analyze.image', 'analyze.video', 'summarize.group'));
  `);
};
