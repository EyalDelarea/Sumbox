/**
 * memory-write.ts — storing what extraction produced.
 *
 * The sibling of `memory-extract.ts`: that module decides what may be learned
 * from and checks the model's output against the messages it was shown; this one
 * takes what survived and puts it away. Split because the two fail differently —
 * extraction fails by believing something untrue, storage fails by attributing it
 * to the wrong person or by losing it silently.
 *
 * ONE MEMORY AT A TIME, THROUGH THE REPOSITORY. `createMemory` owns the
 * transaction that makes "a memory cannot exist without evidence" enforceable,
 * and it is the only door into those tables by design. A bulk insert here would
 * be the second door — it would not break a constraint, it would just quietly
 * stop holding the invariant.
 *
 * NOTHING HERE RETRIES OR REPAIRS. Every way a candidate can fail to store is
 * counted and reported, because the reject rate is the signal for whether the
 * extractor is good enough for the read path to ever trust.
 */
import type pg from "pg";
import { createMemory } from "../db/repositories/aida-memory.js";
import { type CandidateMessage, toSemanticDraft } from "./memory-extract.js";

/** What a run did, keyed by outcome, for printing and for counting over time. */
export type StoreTally = {
  /** A belief that did not exist before. */
  created: number;
  /** An identical belief was already on file; any new citations were added to it. */
  converged: number;
  /**
   * An identical belief was on file and had been REVOKED, so nothing was stored.
   *
   * The number worth watching. It counts how often the extractor keeps
   * re-proposing something a human already withdrew — which is the signal that
   * revocation is not reaching the thing that forms beliefs, and no other outcome
   * can express it.
   */
  convergedOntoRevoked: number;
  /** The author carries no identity, so a belief about them cannot name them. */
  unattributable: number;
  /** Every message the candidate cited was invented, or belongs to another chat. */
  citedNothingReal: number;
};

/** One candidate that passed validation, with the id of the message it cites. */
export type AcceptedCandidate = { sourceMessageId: number; content: string };

/**
 * Store every accepted candidate, and report what happened to each.
 *
 * Sequential rather than concurrent on purpose: each write is its own
 * transaction, and two candidates in the same window can share a dedupe key —
 * running them in parallel would turn ordinary convergence into lock contention
 * for no gain on a job that already waited on a model.
 */
export async function storeAccepted(
  pool: pg.Pool,
  accepted: readonly AcceptedCandidate[],
  shown: ReadonlyMap<number, CandidateMessage>,
  groupId: number,
): Promise<StoreTally> {
  const tally: StoreTally = {
    created: 0,
    converged: 0,
    convergedOntoRevoked: 0,
    unattributable: 0,
    citedNothingReal: 0,
  };

  for (const candidate of accepted) {
    const draft = toSemanticDraft(candidate, shown, groupId);
    if (draft === null) {
      tally.unattributable++;
      continue;
    }
    const written = await createMemory(pool, draft);
    if (written === null) {
      // Not an error: the extractor cited an id it invented, or one from another
      // chat. A normal outcome to count.
      tally.citedNothingReal++;
      continue;
    }
    if (written.outcome === "created") tally.created++;
    else if (written.outcome === "converged") tally.converged++;
    else tally.convergedOntoRevoked++;
  }

  return tally;
}
