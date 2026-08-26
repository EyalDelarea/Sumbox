/**
 * makeMemoryExtractHandler — the `memory.extract` job (@Aida, shadow phase).
 *
 * Reads a window of a group's ordinary conversation, asks the model for durable
 * self-stated facts, validates every candidate against the messages it was
 * actually shown, and writes the survivors as attributed observations. Only
 * messages with an identifiable author are ever read (#88), so every row it
 * writes is attributable to someone real.
 *
 * NOTHING READS THESE ROWS. The whole point of the shadow phase is to accumulate
 * a week of real output so we can look at what she *would* have believed before
 * any of it can affect a reply.
 *
 * Idempotent by construction: the window is explicit in the payload and the
 * observation dedupe key is (group, source message, content hash), so a redelivery
 * or a re-run over the same span converges instead of duplicating.
 *
 * All I/O injected, like every other handler here.
 */
import {
  buildExtractionPrompt,
  type CandidateSelection,
  parseCandidates,
  validateCandidate,
} from "../../ask/memory-extract.js";
import type { Job } from "../../jobs/job-types.js";

export type MemoryExtractResult = {
  groupId: number;
  /** Messages the window held after the D7 exclusions, before the author rule. */
  windowTotal: number;
  /**
   * Of those, how many were dropped because their author is not an identifiable
   * person. Reported because a corpus that shrinks silently reads as a quiet
   * group: measured on group 70, this is ~100 real messages a month, and if it
   * ever approaches `windowTotal` the answer is to fix author resolution
   * upstream, never to relax the rule.
   */
  unattributable: number;
  /** Messages the extractor was actually shown. */
  considered: number;
  /** Candidates the model proposed. */
  proposed: number;
  /** Rows actually written. */
  accepted: number;
  /**
   * Why candidates were dropped, by reason. This is the headline signal of the
   * shadow phase: a high `invented-id` rate means the extractor cannot be
   * trusted with a read path, and it is far more informative than a bare count.
   */
  rejected: Record<string, number>;
};

export type MemoryExtractHandlerDeps = {
  /** Candidates for the window, with what it cost to produce them. */
  selectCandidates: (groupId: number, since: Date, until: Date) => Promise<CandidateSelection>;
  /** Prompt → raw model text. */
  generate: (prompt: string) => Promise<string>;
  /** Writes one observation; returns null when rejected at the DB layer or deduped. */
  recordObservation: (input: {
    groupId: number;
    sourceMessageId: number;
    content: string;
  }) => Promise<number | null>;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

export function makeMemoryExtractHandler(deps: MemoryExtractHandlerDeps) {
  return async function handle(job: Job<"memory.extract">): Promise<MemoryExtractResult> {
    const groupId = Number(job.payload.groupId);
    const since = new Date(job.payload.since);
    const until = new Date(job.payload.until);

    const selection = await deps.selectCandidates(groupId, since, until);
    const considered = selection.candidates;
    const result: MemoryExtractResult = {
      groupId,
      windowTotal: selection.windowTotal,
      unattributable: selection.unattributable,
      considered: considered.length,
      proposed: 0,
      accepted: 0,
      rejected: {},
    };
    // Nothing eligible is the common case for a quiet window, and it is a
    // success, not a failure — throwing here would dead-letter half the runs.
    if (considered.length === 0) return result;

    const shown = new Map(considered.map((m) => [m.messageId, m]));
    const raw = await deps.generate(buildExtractionPrompt(considered));
    const proposed = parseCandidates(raw);
    result.proposed = proposed.length;

    for (const candidate of proposed) {
      const { ok, reason } = validateCandidate(candidate, shown);
      if (!ok) {
        result.rejected[reason ?? "unknown"] = (result.rejected[reason ?? "unknown"] ?? 0) + 1;
        continue;
      }
      // A DB-layer null is a rejection too (message not in this group, or an
      // identical observation already exists), and it is counted separately from
      // the model's own mistakes so the two are never conflated.
      const id = await deps.recordObservation({
        groupId,
        sourceMessageId: ok.sourceMessageId,
        content: ok.content,
      });
      if (id === null)
        result.rejected["deduped-or-rejected"] = (result.rejected["deduped-or-rejected"] ?? 0) + 1;
      else result.accepted += 1;
    }

    deps.log?.info({ ...result }, "@Aida memory extraction (shadow)");
    return result;
  };
}
