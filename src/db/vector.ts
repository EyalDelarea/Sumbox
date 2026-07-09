/**
 * pgvector helpers for the DB layer.
 *
 * Lives here (not in the `ask` feature) because the repositories that store/query
 * embeddings are the primary consumers — the feature layer depends on the DB layer, not
 * the other way around.
 */

/** pgvector text literal for a vector: `[0.1,0.2,...]`. Used as a `$n::vector` param. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
