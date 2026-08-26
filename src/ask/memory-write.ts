/**
 * memory-write.ts — turning what extraction produced into stored memories.
 *
 * The sibling of `memory-extract.ts`. That module decides what may be learned
 * from and checks the model's output against the messages it was shown; this one
 * decides who a belief is about and puts it away. Split because the two fail
 * differently — extraction fails by believing something untrue, storage fails by
 * attributing it to the wrong person or by losing it silently — and the
 * attribution step lives here, with the failure it can cause.
 *
 * ONE MEMORY AT A TIME, THROUGH THE REPOSITORY. `createMemory` owns the
 * transaction that makes "a memory cannot exist without evidence" enforceable,
 * and it is the only door into those tables by design. A bulk insert here would
 * be the second door — it would not break a constraint, it would just quietly
 * stop holding the invariant.
 *
 * EVERY CANDIDATE COMES BACK WITH AN OUTCOME AND, WHEN IT WAS STORED, AN ID.
 * That is not bookkeeping. The safety model for this feature is entirely
 * post-hoc: a bad belief is meant to be found and withdrawn afterwards, and
 * `revokeMemory` takes an id. This run is the only moment where the id, the
 * words, the citation and the author are all in hand at once, so a run that
 * reported "created: 3" and nothing else would make finding those three a
 * database query rather than a scroll back through the output.
 */
import type pg from "pg";
import { createMemory, type MemoryDraft } from "../db/repositories/aida-memory.js";
import { type CandidateMessage, hasAuthorIdentity } from "./memory-extract.js";

/** One candidate that passed validation, with the id of the message it cites. */
export type AcceptedCandidate = { sourceMessageId: number; content: string };

/**
 * What happened to one candidate.
 *
 * Every value is distinguishable on purpose. Two of them look like the same thing
 * and are not: `converged` means the belief was already on file, while
 * `converged_onto_revoked` means it was on file and a human had WITHDRAWN it, so
 * nothing was stored. Collapsing them would erase the only measure of how often
 * the extractor keeps re-proposing something already revoked — the signal that
 * revocation is not reaching the thing that forms beliefs.
 *
 * Two more look alike and are not: `no_author_identity` is the expected,
 * closing historical gap, whereas `not_shown` means a candidate reached storage
 * citing a message the model was never given — a validation bypass. Reporting the
 * second under the first's name would file an alarm as routine.
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
 * ALWAYS `semantic`, and that is a mapping rather than a choice. The extraction
 * prompt has one hard rule — only what the speaker said about THEMSELVES — so
 * every item it can emit is a durable fact about one person, which is exactly
 * what the semantic table holds. Filing them anywhere else would mislabel them,
 * and the other three tables stay empty until a slice writes a prompt that emits
 * a type.
 *
 * THE SUBJECT IS THE AUTHOR OF THE CITED MESSAGE, which follows from that same
 * rule and from nothing else. Worth stating plainly, because the ingest path does
 * not guarantee it in general: in a 1:1 chat `sender_jid` is derived from the
 * chat's remote party, so the owner's own messages there carry the OTHER
 * person's identity. Those rows are excluded upstream today — their participant
 * is JID-shaped, so the author rule drops them — but that is a correlation in
 * Baileys' behaviour, not an invariant, and a belief attributed to the wrong
 * person is the one error revoking cannot undo. Hence the explicit guard below.
 *
 * The raw jid is passed through; `createMemory` canonicalizes it, so one human
 * reached by two WhatsApp identities stays one subject.
 */
export function toSemanticDraft(
  candidate: AcceptedCandidate,
  shown: ReadonlyMap<number, CandidateMessage>,
  groupId: number,
): { draft: MemoryDraft } | { rejected: "no_author_identity" | "not_shown" } {
  const source = shown.get(candidate.sourceMessageId);
  if (!source) {
    // `validateCandidate` already rejects an invented id, so reaching here means
    // a caller skipped validation or built `shown` from a different window. An
    // alarm, not the routine gap below — which is why it has its own outcome.
    return { rejected: "not_shown" };
  }
  if (!hasAuthorIdentity(source.senderJid)) {
    // `semantic.subject_jid` is NOT NULL, and it should be: a belief about a
    // person that cannot say which person is not a belief about a person. Filing
    // it as `episodic` instead — whose subject is nullable — would keep the row
    // by calling a fact about someone an event. The identity is not recoverable
    // either: it came from Baileys' `key.participant` at ingest and was never
    // written down, and a display name cannot stand in because names collapse
    // different people.
    return { rejected: "no_author_identity" };
  }
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
 * by the time a later one fails, earlier beliefs about named real people are
 * already committed. An exception unwinding past this loop would take the record
 * of them with it, and the caller would print an error and exit having stored
 * things it never mentioned. A failure is an outcome on one candidate, and the
 * run continues — the same reason an unattributable candidate does not abort it.
 *
 * Sequential rather than concurrent on purpose: each write is its own
 * transaction, and two candidates in one window can share a dedupe key, so
 * parallelism would turn ordinary convergence into lock contention on a job that
 * already waited on a model.
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
 * Widen the repository's outcome into this module's.
 *
 * A switch rather than an if/else chain so that a new repository outcome is a
 * COMPILE error here. Written as a chain it would fall through to whichever
 * branch happened to be last, and the last one is the number this design says is
 * the one worth watching.
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
