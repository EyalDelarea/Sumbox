/**
 * run.ts — Rosey's aggregation bound to the real database and local Ollama.
 *
 * The composition point for every caller (the `rosey aggregate` CLI today), so
 * they all read the same messages, cursor, and store.
 */

import type pg from "pg";
// @Aida's trigger matcher: a pure module, no path into src/ask (see capture.ts).
import { matchAskTrigger } from "../collector/ask-trigger.js";
import {
  ROSEY_COMMAND_KEY,
  upsertCommandPermission,
} from "../db/repositories/group-command-permissions.js";
import {
  insertTask,
  liveTasksRaisedBetween,
  messagesWithTagEvents,
  type RoseySourceMessage,
  recordStatusEvent,
  resolveRaisedBy,
  selectSourceMessages,
} from "../db/repositories/rosey-tasks.js";
import { getLastRun, recordRun, startSlotIfAbsent } from "../db/repositories/scheduler-state.js";
import { OllamaSummarizer } from "../summarization/summarizer.js";
import { type AggregateReport, aggregateMessages } from "./aggregate.js";
import { applyCommand, type CommandStore } from "./commands.js";
import type { RoseyConfig } from "./config.js";
import { makeTagMatcher } from "./tags.js";

export type Generate = (system: string, user: string) => Promise<string>;

/**
 * The local model as Rosey uses it: a plain prompt → text call through the
 * shared Ollama client. No `format: json` — on short Hebrew input gemma4 loops
 * when asked for structured output; the reply is parsed with lastJsonValue.
 * Low temperature: these are extraction calls, not prose.
 */
export function makeGenerate(cfg: RoseyConfig): Generate {
  const llm = new OllamaSummarizer({
    host: cfg.ollamaHost,
    model: cfg.model,
    numCtx: cfg.numCtx,
    temperature: 0.2,
    numPredict: 2048,
  });
  return async (system, user) => (await llm.summarize({ system, user })).overview;
}

/**
 * How many live tasks a dedup or command lookup reads. Far above a real group's
 * live list (the busiest measured: ~115 suggestions over 90 days), so the cap
 * is a guard against a runaway query, not a filter.
 */
export const DEDUP_CANDIDATE_CAP = 500;

/** The scheduler_state key holding a group's aggregation cursor (ingest time). */
export function cursorKey(groupId: number): string {
  return `rosey-aggregate:${groupId}`;
}

/**
 * Turn Rosey on or off for a group (her own 'rosey' allowlist key). The FIRST
 * enable starts the group's cursor at now, so messages from before she
 * listened are never replayed as commands by the catch-up. A later re-enable
 * leaves the cursor where it is.
 *
 * The same cursor bounds what a pass reads, so passes after enabling suggest
 * only from new messages. To suggest from the history too, run
 * `rosey aggregate --group <id> --from-scratch` once: it re-reads the window
 * while commands stay gated on the cursor, so none from before is replayed.
 */
export async function setRoseyEnabled(
  pool: pg.Pool,
  groupId: number,
  enabled: boolean,
): Promise<void> {
  await upsertCommandPermission(pool, { groupId, command: ROSEY_COMMAND_KEY, enabled });
  if (enabled) await startSlotIfAbsent(pool, cursorKey(groupId));
}

/**
 * The store an explicit @Rosey command writes through. Shared by the live path
 * and the catch-up below, so a command reads and writes the same way whichever
 * of them sees it first.
 */
export function commandStore(pool: pg.Pool, groupId: number): CommandStore {
  return {
    // A generous cap: a "done" looks across every live task of the group.
    liveTasksRaisedBetween: (since, until) =>
      liveTasksRaisedBetween(pool, groupId, since, until, DEDUP_CANDIDATE_CAP),
    insertTagged: async (input) => {
      const raisedBy = await resolveRaisedBy(pool, groupId, [input.sourceMessageId]);
      return insertTask(pool, {
        ...input,
        groupId,
        origin: "tag",
        raisedByParticipantId: raisedBy.get(input.sourceMessageId) ?? null,
      });
    },
    markStatus: (input) => recordStatusEvent(pool, { ...input, source: "tag", groupId }),
  };
}

export type TagCatchUp = {
  /** Commands replayed in this run. */
  commands: number;
  created: number;
  confirmed: number;
  done: number;
  /** A "done" that named no live task, or more than one: nothing changed. */
  noMatch: number;
  ambiguous: number;
  /** A "done" on a task whose status was set by hand: recorded, not applied (D4). */
  refused: number;
  /** Commands that threw; the cursor stays put so they are retried. */
  failures: number;
};

export type RunAggregationResult = {
  report: AggregateReport;
  /**
   * The catch-up: explicit commands nothing has applied. The live path applies a
   * command when it arrives within 120 s of being sent; this pass applies any
   * other one — a reconnect replay, or one whose live apply threw — keyed on
   * whether it was APPLIED, never on timing:
   *  - a command some tag event cites was applied (an event is written even
   *    when D4 refuses the change), and is never replayed;
   *  - a command the live path decided without applying anything (no match, an
   *    ambiguous match, an unresolvable quote) or is still handling is named by
   *    `skipCommand` and left alone — replaying it here, without its quote (the
   *    quoted id is not stored), could close a task the sender never pointed at;
   *  - only messages past the cursor are candidates, even from scratch: each
   *    command gets one attempt per successful pass (a failed pass holds the
   *    cursor back, so it is retried), and an old no-op "done" is never tried
   *    again against tasks that exist only now;
   *  - with no cursor at all, nothing is a candidate: a group's cursor starts
   *    when Rosey is first enabled for it (setRoseyEnabled), so history from
   *    before she listened is never replayed as commands. A group that somehow
   *    has none (enabled by hand in the DB) gets suggestions only on its first
   *    pass, which then starts its cursor;
   *  - a message that wakes @Aida is hers, never a command (see capture.ts).
   */
  tagged: TagCatchUp;
  /** False when any batch failed: those messages are read again next run. */
  cursorAdvanced: boolean;
};

export async function runAggregation(
  pool: pg.Pool,
  groupId: number,
  opts: {
    cfg: RoseyConfig;
    generate: Generate;
    /** Only messages sent within this many days are read. */
    days: number;
    /** Ignore the cursor and re-read the whole window. */
    fromScratch?: boolean;
    onBatchError?: (err: unknown, batch: { index: number; size: number }) => void;
    onCommandError?: (err: unknown, messageId: number) => void;
    /** A command the live path decided or is handling; the catch-up leaves it alone. */
    skipCommand?: (m: RoseySourceMessage) => boolean;
    /**
     * Asked when the pass ends: true holds the cursor back. The live path holds
     * it while a command it claimed is still unapplied — if that apply then
     * throws, the command must still be past the cursor to be replayed.
     */
    holdCursor?: () => boolean;
    now?: () => Date;
  },
): Promise<RunAggregationResult> {
  const now = opts.now ?? (() => new Date());
  // Taken BEFORE reading, so a message ingested during the run is newer than
  // the cursor it leaves behind and is read next time. Read from the DATABASE
  // clock: the cursor is compared with messages.created_at, which the database
  // stamps, and a host clock running ahead of it would skip every message
  // ingested in the gap.
  const startedAt = await databaseNow(pool);
  const cursor = await getLastRun(pool, cursorKey(groupId));
  const changedSince = opts.fromScratch ? null : cursor;
  const messages = await selectSourceMessages(pool, groupId, {
    sentSince: new Date(now().getTime() - opts.days * 86_400_000),
    changedSince,
  });

  const tags = makeTagMatcher(opts.cfg.tags);
  const tagged: TagCatchUp = {
    commands: 0,
    created: 0,
    confirmed: 0,
    done: 0,
    noMatch: 0,
    ambiguous: 0,
    refused: 0,
    failures: 0,
  };
  // `>=`: the cursor is a millisecond Date and created_at has microseconds, so a
  // message stored in the cursor's own millisecond is read by the query above;
  // dropping it here would lose it. Re-trying it is safe: an applied command is
  // cited by a tag event, and a live-decided one is named by skipCommand.
  const candidates = messages.filter(
    (m) => !m.isVoice && cursor !== null && m.ingestedAt >= cursor && !matchAskTrigger(m.content),
  );
  const applied = await messagesWithTagEvents(
    pool,
    candidates.map((m) => m.messageId),
  );
  const store = commandStore(pool, groupId);
  // Commands first: an explicit tag wins (D3), so suggestions dedup against it.
  for (const m of candidates) {
    if (applied.has(m.messageId)) continue;
    const cmd = tags.parse(m.content.trim());
    if (!cmd) continue;
    // Asked at the moment of replay: the live path may have decided it since the read.
    if (opts.skipCommand?.(m)) continue;
    tagged.commands++;
    try {
      // No quote here (the quoted id is not stored), so a late quote-only "done"
      // has no scope and applies nothing; it is counted as noMatch.
      const out = await applyCommand(
        cmd,
        { groupId, messageId: m.messageId, sentAt: m.sentAt, quotedMessageId: null },
        store,
      );
      if (out.kind === "added") {
        tagged.created += out.created;
        tagged.confirmed += out.confirmed;
      } else if (out.kind === "done") tagged.done++;
      else if (out.kind === "done_refused") tagged.refused++;
      else if (out.kind === "done_no_match") tagged.noMatch++;
      else tagged.ambiguous++;
    } catch (err) {
      tagged.failures++;
      opts.onCommandError?.(err, m.messageId);
    }
  }

  const report = await aggregateMessages(messages, {
    generate: opts.generate,
    isTagged: tags.isTagged,
    resolveRaisedBy: (ids) => resolveRaisedBy(pool, groupId, ids),
    liveTasksRaisedBetween: (since, until) =>
      liveTasksRaisedBetween(pool, groupId, since, until, DEDUP_CANDIDATE_CAP),
    insertSuggestion: (input) => insertTask(pool, { ...input, groupId, origin: "suggested" }),
    onBatchError: opts.onBatchError,
  });

  const cursorAdvanced =
    report.batchFailures === 0 && tagged.failures === 0 && !opts.holdCursor?.();
  if (cursorAdvanced) await recordRun(pool, cursorKey(groupId), startedAt);
  return { report, tagged, cursorAdvanced };
}

async function databaseNow(pool: pg.Pool): Promise<Date> {
  const { rows } = await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t");
  return rows[0]!.t;
}
