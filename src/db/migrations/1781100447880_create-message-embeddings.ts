import type { MigrationBuilder } from "node-pg-migrate";

// Mirror of the default tenant id (migration 022). Inlined, not imported —
// node-pg-migrate loads each migration via raw ESM resolution and cannot resolve
// cross-migration imports.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// bge-m3 (the default embedding model) emits 1024-dimensional vectors.
const EMBEDDING_DIM = 1024;

/**
 * Semantic-search storage for the `ask` feature: one embedding row per message,
 * keyed by message_id. Adds the pgvector extension, the embeddings table, an HNSW
 * cosine index for ANN search, and the standard tenant_id + RLS scoping (mirrors
 * migrations 023/025).
 *
 * Why a side table (not a column on messages): embeddings are produced lazily by a
 * backfill/ingestion pass against a local Ollama model, so most messages have none
 * yet; a NOT NULL side row keeps `messages` lean and makes "needs embedding" a
 * simple anti-join. ON CONFLICT (message_id) makes (re)embedding idempotent.
 *
 * HNSW (not ivfflat) needs no training step and stays accurate as rows trickle in
 * via incremental backfill — ivfflat lists would be built on an empty table.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql("CREATE EXTENSION IF NOT EXISTS vector");

  pgm.sql(`
    CREATE TABLE message_embeddings (
      id bigserial PRIMARY KEY,
      message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL
        DEFAULT COALESCE(current_setting('app.tenant_id', true)::uuid, '${DEFAULT_TENANT_ID}')
        REFERENCES tenants(id),
      embedding vector(${EMBEDDING_DIM}) NOT NULL,
      model text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT message_embeddings_message_id_unique UNIQUE (message_id)
    );

    CREATE INDEX message_embeddings_tenant_idx ON message_embeddings (tenant_id, message_id);

    -- ANN index for cosine similarity (1 - cosine distance). The retriever orders by
    -- the <=> (cosine distance) operator, which this index accelerates.
    CREATE INDEX message_embeddings_embedding_idx
      ON message_embeddings USING hnsw (embedding vector_cosine_ops);
  `);

  // Tenant isolation — same fail-closed pattern as migration 025.
  pgm.sql(`
    ALTER TABLE message_embeddings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE message_embeddings FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON message_embeddings
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql("DROP TABLE IF EXISTS message_embeddings");
  // Leave the `vector` extension installed: dropping it is cluster-wide and could
  // break other databases sharing the server (e.g. the test template clones).
};
