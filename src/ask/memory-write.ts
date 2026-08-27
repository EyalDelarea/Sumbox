/**
 * memory-write.ts — turning what extraction produced into stored memories.
 *
 * The sibling of `memory-extract.ts`: that module decides what may be learned
 * from and what may be believed about whom, this one decides which identity a
 * belief is filed against and puts it away. Split because they fail differently —
 * extraction fails by believing something untrue, storage fails by attributing it
 * to the wrong person or losing it silently.
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
import {
  canonicalSubjectJid,
  createMemory,
  type MemoryDraft,
} from "../db/repositories/aida-memory.js";
import type { SubjectIdentity, ValidatedCandidate } from "./memory-extract.js";

/** One candidate that cleared validation and containment. */
export type AcceptedCandidate = ValidatedCandidate;

/**
 * What happened to one candidate. Several pairs look alike and are deliberately
 * not:
 *
 * `converged` = already on file. `converged_onto_revoked` = already on file and
 * WITHDRAWN by a human, so nothing was stored — the only measure of how often the
 * extractor re-proposes something already revoked.
 *
 * `no_author_identity` = the belief names somebody real who never left a
 * WhatsApp identity behind; the expected, closing historical gap.
 * `ambiguous_subject` = it names somebody who answers to two identities that do
 * not resolve to one person, so filing it would pick one at random.
 * `subjects_collapsed` = a relationship whose two people turned out to be one.
 */
export type StoreOutcome =
  | "created"
  | "converged"
  | "converged_onto_revoked"
  | "no_author_identity"
  | "ambiguous_subject"
  | "subjects_collapsed"
  | "cited_nothing_real"
  | "failed";

/** Why a candidate never became a draft. A subset of {@link StoreOutcome}. */
export type DraftRejection = "no_author_identity" | "ambiguous_subject" | "subjects_collapsed";

export type StoreResult = {
  candidate: AcceptedCandidate;
  outcome: StoreOutcome;
  /** Present only when a row was written or converged onto — what `revoke` takes. */
  memoryId?: number;
  /** Present only on `failed`. */
  error?: string;
};

/**
 * The one identity a named subject is filed against, or why there isn't one.
 *
 * A subject carries every identity it spoke under, and canonicalization is what
 * collapses the ordinary case — the same human reaching the group as an `@lid`
 * and as a phone JID — into one. What survives that and is still plural is a
 * label two different people answer to, and there is no honest way to pick: this
 * is exactly the mis-attribution the design calls unrecoverable, since revoking a
 * belief cannot un-hold it about the wrong person.
 */
async function identityFor(
  client: pg.Pool | pg.PoolClient,
  subject: SubjectIdentity,
): Promise<{ jid: string } | { rejected: DraftRejection }> {
  const canonical = [
    ...new Set(await Promise.all(subject.jids.map((j) => canonicalSubjectJid(client, j)))),
  ];
  const only = canonical[0];
  if (only === undefined) return { rejected: "no_author_identity" };
  if (canonical.length > 1) return { rejected: "ambiguous_subject" };
  return { jid: only };
}

/**
 * Decide who a belief is about, and shape it for the repository.
 *
 * THE SUBJECT IS THE PERSON THE MODEL NAMED, not the author of the cited message.
 * That is the change slice 4a makes: the shipped prompt could only emit
 * self-statements, so author and subject were the same person by construction.
 * They are not any more, which is why `validateCandidate` refuses a name that
 * never spoke here and holds a claim about anyone but the speaker to two voices
 * before it ever reaches this function.
 *
 * A NAMED SUBJECT WITH NO IDENTITY IS REFUSED, NOT DOWNGRADED. Storing it as an
 * `episodic` memory with a null subject would keep the row by calling a fact
 * about someone an event, and the identity is not recoverable — it was never
 * written down. Only a candidate that named NOBODY becomes a subject-less
 * episodic memory.
 */
export async function toDraft(
  client: pg.Pool | pg.PoolClient,
  candidate: ValidatedCandidate,
  groupId: number,
): Promise<{ draft: MemoryDraft } | { rejected: DraftRejection }> {
  // The prompt cannot express disagreement, so every citation it produces
  // supports the belief it came with. A `contradicts` stance is a human's to
  // record, from the review surface.
  const evidence = candidate.citations.map((messageId) => ({
    messageId,
    stance: "supports" as const,
  }));
  const base = { groupId, content: candidate.content, evidence };

  const identities: string[] = [];
  for (const subject of candidate.subjects) {
    const resolved = await identityFor(client, subject);
    if ("rejected" in resolved) return resolved;
    identities.push(resolved.jid);
  }

  switch (candidate.memoryType) {
    case "self_state":
      return {
        draft: {
          ...base,
          memoryType: "self_state",
          // `validateCandidate` refuses a `self_state` without one, so an absent
          // facet here means a caller skipped it. Default rather than throw: the
          // gentler of the two is a memory filed as knowledge instead of a rule.
          facet: candidate.facet ?? "knowledge",
        },
      };
    case "episodic":
      return {
        draft: { ...base, memoryType: "episodic", subjectJid: identities[0] ?? null },
      };
    case "semantic": {
      const subjectJid = identities[0];
      // Unreachable through `validateCandidate`, which requires exactly one
      // subject for a semantic memory — but `semantic.subject_jid` is NOT NULL and
      // a belief about a person that cannot say which person is not one.
      if (subjectJid === undefined) return { rejected: "no_author_identity" };
      return { draft: { ...base, memoryType: "semantic", subjectJid } };
    }
    case "relational": {
      // Canonicalization can COLLAPSE the pair — two lids linked to one phone JID,
      // or a label two members share. A relationship between one person is not a
      // relationship, and `createMemory` would throw on it; counted here instead,
      // because it is a normal thing for a model reading a chat to propose.
      const distinct = [...new Set(identities)];
      if (distinct.length < 2) return { rejected: "subjects_collapsed" };
      return { draft: { ...base, memoryType: "relational", subjectJids: distinct } };
    }
  }
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
  groupId: number,
): Promise<StoreResult[]> {
  const results: StoreResult[] = [];

  for (const candidate of accepted) {
    try {
      const mapped = await toDraft(pool, candidate, groupId);
      if ("rejected" in mapped) {
        results.push({ candidate, outcome: mapped.rejected });
        continue;
      }
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
