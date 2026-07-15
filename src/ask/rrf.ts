/**
 * Reciprocal Rank Fusion — merge several ranked id lists into one ranking.
 *
 * Each list is ids in rank order (best first). An id's fused score is the sum,
 * over the lists it appears in, of `1 / (C + rank0)` (rank0 is 0-based). So an
 * id near the top of BOTH the semantic and lexical lists outranks one that only
 * one method liked — which is exactly the point of hybrid retrieval: agreement
 * wins. C dampens the contribution of low ranks; 60 is the standard value.
 *
 * Pure, DB-free, and unit-tested independently of retrieval.
 */
export function rrfFuse(lists: number[][], c = 60): number[] {
  const score = new Map<number, number>();
  // First-seen order gives a stable tiebreak for equal scores.
  const firstSeen = new Map<number, number>();
  let seq = 0;
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!;
      score.set(id, (score.get(id) ?? 0) + 1 / (c + rank));
      if (!firstSeen.has(id)) firstSeen.set(id, seq++);
    }
  }
  return [...score.keys()].sort((a, b) => {
    const d = score.get(b)! - score.get(a)!;
    return d !== 0 ? d : firstSeen.get(a)! - firstSeen.get(b)!;
  });
}
