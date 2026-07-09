import type { MigrationBuilder } from "node-pg-migrate";

// GIN index over the 'simple' tsvector of message text, so lexical retrieval
// for the `ask` feature is fast at 291k+ rows. 'simple' config (no Hebrew
// stemming) is an accepted PR1 limitation; PR2 adds semantic recall via pgvector.
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(
    "CREATE INDEX messages_text_fts_idx ON messages " +
      "USING gin (to_tsvector('simple', coalesce(text_content, '')))",
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP INDEX IF EXISTS messages_text_fts_idx");
};
