import type { MigrationBuilder } from "node-pg-migrate";

/**
 * `content_hash` — md5 of the CONTENT_EXPR text an embedding was derived FROM,
 * so the sweep can tell a current vector from a stale one.
 *
 * The bug it closes: a captioned photo has non-empty content at ingest (the
 * caption is mapped to text_content by collector/message-mapper.ts), so the 30s
 * sweep embeds it on the caption ALONE; the vision description lands minutes
 * later and the vector is never refreshed, because the sweep only ever selected
 * rows with NO embedding at all. The photo stayed findable by its caption but not
 * by what was in it. It is a race — whichever of vision-analysis / sweep-tick
 * lands first — which is why it bit 92 of 5,592 enriched messages, not all.
 *
 * Hash rather than a timestamp comparison: the hash compares the content itself
 * rather than a proxy for it — no OR-chain across two nullable joins, no reliance
 * on cross-table clock ordering, and it still holds for a caption edit or any
 * future content source. See selectMessagesNeedingEmbedding for the full rationale.
 *
 * Nullable, and deliberately only PARTIALLY seeded: NULL means "unknown, assume
 * stale". See the seed below.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn("message_embeddings", {
    content_hash: {
      type: "text",
      notNull: false,
      comment:
        "md5 of the content this embedding was derived from; NULL = unknown, re-embed. Written only by the sweep, from the hash its own SELECT computed.",
    },
  });

  /**
   * Seed ONLY rows that cannot possibly be stale: a message with no completed
   * analysis or transcript has no enrichment path, so its vector still matches its
   * content by construction. Seeding those asserts nothing we have not proven.
   *
   * That premise rests on text_content being immutable after insert (insertMessages
   * is ON CONFLICT DO NOTHING; nothing else writes it). If a WhatsApp message-EDIT
   * path is ever added, this seed becomes retroactively wrong for the rows it has
   * already stamped — they would claim to be current while holding a vector of the
   * pre-edit text. Whoever adds editing must re-NULL these hashes.
   *
   * Every enriched row is left NULL on purpose, so the sweep re-derives all ~5.6k
   * of them (~45min at 64/30s, incremental, resumable, non-blocking — @Aida keeps
   * working on the vectors already present). Deliberately wider than the 92 rows
   * measured as stale: re-deriving an enriched vector costs one embed and is
   * provably correct, whereas seeding a hash we have not verified would bake in
   * "this vector is current" forever, with no way to ever detect it if wrong.
   *
   * Mirrors CONTENT_EXPR / CONTENT_JOINS in repositories/message-embeddings.ts.
   * Inlined rather than imported: a migration is a historical record and must keep
   * running unchanged even after that expression evolves.
   */
  pgm.sql(`
    UPDATE message_embeddings e
       SET content_hash = md5(concat_ws(' — ',
             NULLIF(trim(m.text_content), ''),
             NULLIF(trim(a.description), ''),
             NULLIF(trim(t.transcript), '')
           ))
      FROM messages m
      LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
      LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
     WHERE e.message_id = m.id
       AND a.description IS NULL
       AND t.transcript IS NULL
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn("message_embeddings", "content_hash");
};
