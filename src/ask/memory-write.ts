/**
 * memory-write.ts — turning what extraction produced into stored memories.
 *
 * The sibling of `memory-extract.ts`: that module decides what may be learned
 * from, this one decides who a belief is about and puts it away. Split because
 * they fail differently — extraction fails by believing something untrue, storage
 * fails by attributing it to the wrong person or losing it silently.
 *
 * ONE MEMORY AT A TIME, THROUGH THE REPOSITORY. `createMemory` owns the
 * transaction that makes "a memory cannot exist without evidence" enforceable,
 * and is the only door into those tables. A bulk insert here would be a second
 * door that quietly stops holding the invariant.
 *
 * EVERY CANDIDATE COMES BACK WITH AN OUTCOME, AND AN ID WHEN IT WAS STORED. The
 * safety model is entirely post-hoc and `revokeMemory` takes an id; this run is
 * the only moment where the id, the words, the citation and the author are all in
 * hand at once.
 */
import type pg from "pg";
import { createMemory, type MemoryDraft } from "../db/repositories/aida-memory.js";
import { type CandidateMessage, hasAuthorIdentity } from "./memory-extract.js";

/** One candidate that passed validation, with the id of the message it cites. */
export type AcceptedCandidate = { sourceMessageId: number; content: string };

/**
 * What happened to one candidate. Two pairs look alike and are deliberately not:
 *
 * `converged` = already on file. `converged_onto_revoked` = already on file and
 * WITHDRAWN by a human, so nothing was stored — the only measure of how often the
 * extractor re-proposes something already revoked.
 *
 * `no_author_identity` = the expected, closing historical gap. `not_shown` = a
 * candidate reached storage citing a message the model was never given, which is
 * a validation bypass and should not read as routine.
 */
export type StoreOutcome =
  | "created"
  | "converged"
  | "converged_onto_revoked"
  | "no_author_identity"
  | "not_shown"
  | "cited_nothing_real"
  | "failed";

export type StoreResult = {
  candidate: AcceptedCandidate;
  outcome: StoreOutcome;
  /** Present only when a row was written or converged onto — what `revoke` takes. */
  memoryId?: number;
  /** Present only on `failed`. */
  error?: string;
};

/**
 * Decide who a belief is about, and shape it for the repository.
 *
 * ALWAYS `semantic`, as a mapping rather than a choice: the prompt's one hard
 * rule is *only what the speaker said about THEMSELVES*, so every item it emits
 * is a durable fact about one person. The other three tables stay empty until a
 * slice writes a prompt that emits a type.
 *
 * THE SUBJECT IS THE AUTHOR OF THE CITED MESSAGE, which follows from that rule
 * and nothing else — the ingest path does not guarantee it in general, which is
 * why `selectCandidates` refuses 1:1 self-messages before they reach here.
 *
 * The raw jid is passed through; `createMemory` canonicalizes it, so one human
 * under two WhatsApp identities stays one subject.
 */
export function toSemanticDraft(
  candidate: AcceptedCandidate,
  shown: ReadonlyMap<number, CandidateMessage>,
  groupId: number,
): { draft: MemoryDraft } | { rejected: "no_author_identity" | "not_shown" } {
  const source = shown.get(candidate.sourceMessageId);
  // `validateCandidate` already rejects an invented id, so reaching here means a
  // caller skipped validation or built `shown` from another window.
  if (!source) return { rejected: "not_shown" };
  // `semantic.subject_jid` is NOT NULL and should be: a belief about a person
  // that cannot say which person is not one. Filing it as `episodic` instead
  // would keep the row by calling a fact about someone an event, and the identity
  // is not recoverable — it was never written down.
  if (!hasAuthorIdentity(source.senderJid)) return { rejected: "no_author_identity" };
  return {
    draft: {
      memoryType: "semantic",
      groupId,
      subjectJid: (source.senderJid as string).trim(),
      content: candidate.content,
      // The prompt cites exactly one id per item and cannot express disagreement,
      // so every citation it produces supports the belief it came with.
      evidence: [{ messageId: candidate.sourceMessageId, stance: "supports" }],
    },
  };
}

/**
 * Store every accepted candidate, and report what happened to each one.
 *
 * NOTHING THROWS OUT OF HERE. `createMemory` owns a transaction PER CANDIDATE, so
 * a failure on the fourth leaves the first three committed — and an exception
 * unwinding past this loop would take the record of them with it, leaving beliefs
 * on file that the run never mentioned. Failure is an outcome on one candidate.
 *
 * Sequential, not concurrent: two candidates in one window can share a dedupe
 * key, so parallelism would turn ordinary convergence into lock contention.
 */
export async function storeAccepted(
  pool: pg.Pool,
  accepted: readonly AcceptedCandidate[],
  shown: ReadonlyMap<number, CandidateMessage>,
  groupId: number,
): Promise<StoreResult[]> {
  const results: StoreResult[] = [];

  for (const candidate of accepted) {
    const mapped = toSemanticDraft(candidate, shown, groupId);
    if ("rejected" in mapped) {
      results.push({ candidate, outcome: mapped.rejected });
      continue;
    }
    try {
      const written = await createMemory(pool, mapped.draft);
      if (written === null) {
        // Not an error: the cited message is not in this group — either invented,
        // or deleted between selection and storage. A normal outcome to count.
        results.push({ candidate, outcome: "cited_nothing_real" });
        continue;
      }
      results.push({ candidate, outcome: outcomeOf(written.outcome), memoryId: written.id });
    } catch (err) {
      results.push({
        candidate,
        outcome: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Widen the repository's outcome into this module's. A switch, not a chain, so a
 * new repository outcome is a COMPILE error rather than falling through to
 * whichever branch is last — which here is the number worth watching.
 */
function outcomeOf(outcome: "created" | "converged" | "converged_onto_revoked"): StoreOutcome {
  switch (outcome) {
    case "created":
      return "created";
    case "converged":
      return "converged";
    case "converged_onto_revoked":
      return "converged_onto_revoked";
    default: {
      const unreachable: never = outcome;
      throw new Error(`storeAccepted: unhandled write outcome ${String(unreachable)}`);
    }
  }
}

/** Count results by outcome. Only non-zero outcomes appear, so a clean run reads short. */
export function tally(results: readonly StoreResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return counts;
}
