/**
 * memory-repair-run.ts — running the blind repair pass over stored beliefs.
 *
 * The impure half of `memory-repair.ts`: it reads beliefs and their cited
 * messages, asks the model about each one on its own, and — only when told to —
 * writes the result back as a supersession or a withdrawal.
 *
 * ONE BELIEF PER MODEL CALL, and never a batch. Batching is what the extractor
 * does, and it is where the errors this pass exists to catch were made: shown ten
 * beliefs at once the model harmonises them, and a belief about where someone
 * lives starts borrowing from the one two lines above it. The cost is real (one
 * local call per belief) and it buys the isolation that is the entire mechanism.
 *
 * IT RUNS OVER STORED ROWS, NOT ONLY NEW CANDIDATES. The input is the same either
 * way — a belief and the messages it cites — so the pass that will one day sit
 * inside extraction can be measured today against beliefs whose correct answers
 * are already known. That is the only labelled data this feature has.
 *
 * NOTHING IS WRITTEN WITHOUT `write`. The default prints what it would do, for
 * the same reason `--extract` is a dry run: the operator has to be able to read a
 * pass before trusting it, and this one can withdraw beliefs.
 */
import type pg from "pg";
import {
  correctMemory,
  flagMemory,
  listLiveMemories,
  listMemoryEvidence,
  type MemoryType,
  type StoredMemory,
} from "../db/repositories/aida-memory.js";
import { resolveSenderName } from "../summarization/sender-name.js";
import {
  buildJudgePrompt,
  buildRepairPrompt,
  type CitedMessage,
  type JudgeRejection,
  parseRepair,
  type RepairRejection,
  type RepairVerdict,
  truncateCitedText,
  validateJudge,
  validateRepair,
} from "./memory-repair.js";

/**
 * The model, as this pass needs it.
 *
 * An interface rather than the summarizer, so a test can hand it a scripted reply
 * and so the pass never grows a dependency on how the project happens to reach
 * Ollama today. Q25: it is the SAME model extraction uses, deliberately — if a
 * narrow re-read fixes what open extraction got wrong, the asymmetry this pass
 * is built on is real, and if it repeats the errors that is the cleanest possible
 * evidence the mechanism is wrong.
 */
export interface RepairModel {
  ask(prompt: string): Promise<string>;
}

/**
 * What was done about one belief, or why nothing was.
 *
 * `no_evidence` is not a model outcome and is kept apart from one. It means every
 * message the belief was traced to has been deleted, so there is nothing to read
 * it back against — the belief is unfalsifiable rather than wrong, and asking the
 * model about it would invent a verdict out of an empty prompt.
 */
export type RepairOutcome =
  // `step` tells apart two verdicts a human reading the artifact must not
  // conflate: "judge" is the belief passing the cheap yes/no check outright;
  // "repair" is the judge calling it unsupported and the repair prompt
  // answering "keep" anyway — the two steps disagreeing with each other,
  // which is the exact failure the split was measured into existence to
  // catch (see the header comment on `buildJudgePrompt`). Both used to land
  // as the same `{kind:"kept"}` with no way to distinguish them afterward.
  | { kind: "kept"; step: "judge" | "repair"; verdict: RepairVerdict }
  | { kind: "rewritten"; verdict: RepairVerdict; written: boolean; newMemoryId?: number }
  | { kind: "flagged"; verdict: RepairVerdict; written: boolean }
  | { kind: "refused"; reason: RepairRejection | JudgeRejection; reply: string }
  | { kind: "no_evidence"; reason: string }
  | { kind: "failed"; error: string };

/** One belief, what it cited, and what the pass decided. */
export type RepairRecord = {
  memoryType: MemoryType;
  memoryId: number;
  before: string;
  cited: CitedMessage[];
  outcome: RepairOutcome;
};

export type RepairRun = {
  groupId: number;
  records: RepairRecord[];
  tally: Record<string, number>;
};

/**
 * The note a repair leaves on the row it supersedes.
 *
 * `correction_note` was introduced as the one signal telling a human-written row
 * from an extracted one, and a repair is NEITHER — it is the model re-reading
 * itself. Rather than add a column for a third case before we know the pass is
 * worth keeping, every repair note carries this prefix, so the three are still
 * distinguishable by anything that looks. If the pass ships, that prefix wants to
 * become a column.
 */
export const REPAIR_NOTE_PREFIX = "repair:";

// ── Reading a belief's evidence ───────────────────────────────────────────

/**
 * The text of the messages a belief cites, in the order they were sent.
 *
 * Names go through `resolveSenderName`, the same rendering the extraction prompt
 * used. A belief written about "Royi" must be read back against a message
 * labelled "Royi": if the two renderings differed, the pass would judge every
 * self-report to be about somebody else and rewrite correct beliefs.
 *
 * A message whose row is gone simply does not come back. Evidence cascades on
 * message deletion, so this is the same set the ledger holds — it just cannot be
 * assumed non-empty, which is what `no_evidence` above is for.
 *
 * TEXT IS TRUNCATED HERE, TO THE SAME BOUND THE PROMPT USES. A `RepairRecord`
 * is the artifact a human reads to judge the pass; if it carried the full
 * message while the prompt saw only the first `MAX_CITED_MESSAGE_CHARS`
 * characters, the record would misrepresent what the model was actually shown.
 * `truncateCitedText` is the identical transform `renderCited` applies, so a
 * cited message's stored `text` already equals what the prompt renders for it.
 */
export async function citedMessagesFor(
  client: pg.Pool | pg.PoolClient,
  input: { memoryType: MemoryType; memoryId: number },
): Promise<CitedMessage[]> {
  const evidence = await listMemoryEvidence(client, input);
  const ids = evidence.map((e) => e.messageId);
  if (ids.length === 0) return [];
  const { rows } = await client.query<{
    id: string;
    sender: string | null;
    content: string | null;
  }>(
    `SELECT m.id, p.display_name AS sender, m.text_content AS content
       FROM messages m
       LEFT JOIN participants p ON p.id = m.participant_id
      WHERE m.id = ANY($1::bigint[])
      ORDER BY m.sent_at, m.id`,
    [ids],
  );
  return rows
    .filter((r) => (r.content ?? "").trim().length > 0)
    .map((r) => ({
      messageId: Number(r.id),
      author: resolveSenderName(r.sender ?? ""),
      text: truncateCitedText(r.content ?? ""),
    }));
}

// ── The run ───────────────────────────────────────────────────────────────

/**
 * Re-read every live belief in a group against its own citations.
 *
 * ONE FAILURE DOES NOT END THE RUN. A model that times out on belief seven must
 * not cost the verdicts on one through six: this pass is the measurement, and a
 * partial run that says which belief broke is worth more than an exception. Each
 * failure is recorded against its belief and counted.
 */
export async function repairGroupMemories(
  pool: pg.Pool,
  input: {
    groupId: number;
    model: RepairModel;
    /** Write supersessions and withdrawals. Default false — the run only prints. */
    write?: boolean;
    /** Cap the beliefs read, for a quick look at a large group. */
    limit?: number;
  },
): Promise<RepairRun> {
  const beliefs: StoredMemory[] = await listLiveMemories(pool, {
    groupId: input.groupId,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const records: RepairRecord[] = [];
  const tally: Record<string, number> = {};
  const count = (key: string) => {
    tally[key] = (tally[key] ?? 0) + 1;
  };

  for (const belief of beliefs) {
    const base = {
      memoryType: belief.memoryType,
      memoryId: belief.id,
      before: belief.content,
    };
    const cited = await citedMessagesFor(pool, {
      memoryType: belief.memoryType,
      memoryId: belief.id,
    });
    if (cited.length === 0) {
      count("no_evidence");
      records.push({
        ...base,
        cited,
        outcome: { kind: "no_evidence", reason: "every cited message has been deleted" },
      });
      continue;
    }

    const under = { memoryType: belief.memoryType, content: belief.content };

    // ── Step one: supported, yes or no. Nothing else is on the table.
    //
    // Asked to judge and correct at once the model kept nothing — 0 of 11, three
    // identical runs, and 0 again after being told in words that keeping is the
    // normal answer. A keep only survives as the answer to a closed question.
    let judgeReply: string;
    try {
      judgeReply = await input.model.ask(buildJudgePrompt(under, cited));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      count("failed");
      records.push({ ...base, cited, outcome: { kind: "failed", error } });
      continue;
    }
    const judged = validateJudge(parseRepair(judgeReply));
    if (!judged.ok) {
      count(`refused_${judged.reason ?? "unknown"}`);
      records.push({
        ...base,
        cited,
        outcome: { kind: "refused", reason: judged.reason ?? "not-an-object", reply: judgeReply },
      });
      continue;
    }
    if (judged.ok.supported) {
      count("kept");
      records.push({
        ...base,
        cited,
        outcome: {
          kind: "kept",
          step: "judge",
          verdict: { action: "keep", content: belief.content, reason: judged.ok.reason },
        },
      });
      continue;
    }

    // ── Step two: it is not supported. Correct it, or drop it.
    let reply: string;
    try {
      reply = await input.model.ask(buildRepairPrompt(under, cited));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      count("failed");
      records.push({ ...base, cited, outcome: { kind: "failed", error } });
      continue;
    }

    const { ok, reason } = validateRepair(parseRepair(reply), belief.content);
    if (!ok) {
      count(`refused_${reason ?? "unknown"}`);
      records.push({
        ...base,
        cited,
        outcome: { kind: "refused", reason: reason ?? "unparseable", reply },
      });
      continue;
    }

    if (ok.action === "keep") {
      count("kept");
      records.push({ ...base, cited, outcome: { kind: "kept", step: "repair", verdict: ok } });
      continue;
    }

    if (ok.action === "rewrite") {
      if (!input.write) {
        count("would_rewrite");
        records.push({
          ...base,
          cited,
          outcome: { kind: "rewritten", verdict: ok, written: false },
        });
        continue;
      }
      const result = await correctMemory(pool, {
        memoryType: belief.memoryType,
        groupId: input.groupId,
        memoryId: belief.id,
        content: ok.content,
        note: `${REPAIR_NOTE_PREFIX} ${ok.reason}`,
      });
      if (!result.ok) {
        count(`rewrite_failed_${result.reason}`);
        records.push({
          ...base,
          cited,
          outcome: { kind: "failed", error: `supersede refused: ${result.reason}` },
        });
        continue;
      }
      count("rewritten");
      records.push({
        ...base,
        cited,
        outcome: { kind: "rewritten", verdict: ok, written: true, newMemoryId: result.memoryId },
      });
      continue;
    }

    // A DROP VERDICT RAISES A FLAG. IT NEVER WITHDRAWS THE BELIEF.
    //
    // Measured on group 70: of four drop verdicts, two were beliefs that were
    // TRUE and that the pass had misread — one of them on a Hebrew word it
    // translated wrongly. An automatic revoke would have destroyed both, and a
    // revoked belief has no surface saying it was ever doubted. Every failure of
    // this kind was an episodic or relational belief with several citations,
    // which is exactly the open-ended reading the pass is worst at.
    //
    // So the pass may PROPOSE removal and may never perform it. A correction
    // supersedes, which is visible and reversible; a doubt becomes a question for
    // the operator. Nothing this pass does can lose a belief.
    if (!input.write) {
      count("would_flag");
      records.push({ ...base, cited, outcome: { kind: "flagged", verdict: ok, written: false } });
      continue;
    }
    await flagMemory(pool, {
      memoryType: belief.memoryType,
      memoryId: belief.id,
      reason: ok.reason,
    });
    count("flagged");
    records.push({ ...base, cited, outcome: { kind: "flagged", verdict: ok, written: true } });
  }

  return { groupId: input.groupId, records, tally };
}
