/**
 * run.ts — Rosey's aggregation bound to the real database and local Ollama.
 *
 * The composition point for every caller (the `rosey aggregate` CLI today), so
 * they all read the same messages, cursor, and store.
 */

import type pg from "pg";
import {
  insertTask,
  liveTasksRaisedBetween,
  messagesWithTagEvents,
  recordStatusEvent,
  resolveRaisedBy,
  selectSourceMessages,
} from "../db/repositories/rosey-tasks.js";
import { getLastRun, recordRun } from "../db/repositories/scheduler-state.js";
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

/** Mirrors capture.ts: a message older than this on arrival was never applied live. */
const LIVE_HORIZON_MS = 120_000;

export type TagCatchUp = {
  /** Late commands applied in this run. */
  commands: number;
  created: number;
  confirmed: number;
  done: number;
  /** A "done" that named no live task, or more than one: nothing changed. */
  noMatch: number;
  ambiguous: number;
  /** Commands that threw; the cursor stays put so they are retried. */
  failures: number;
};

export type RunAggregationResult = {
  report: AggregateReport;
  /**
   * Late explicit commands. The live path applies a command only when it arrives
   * within 120 s of being sent; one delivered later (a reconnect replay after the
   * collector was down) is applied here instead, exactly once:
   *  - a message stored within the horizon of its send time was the live path's
   *    to apply, and is never replayed — replaying it without its quote, or after
   *    its task closed, could close or recreate the wrong task;
   *  - a late message already cited by a tag event was applied by an earlier pass.
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
  const changedSince = opts.fromScratch ? null : await getLastRun(pool, cursorKey(groupId));
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
    failures: 0,
  };
  const late = messages.filter(
    (m) => !m.isVoice && m.ingestedAt.getTime() - m.sentAt.getTime() > LIVE_HORIZON_MS,
  );
  const applied = await messagesWithTagEvents(
    pool,
    late.map((m) => m.messageId),
  );
  const store = commandStore(pool, groupId);
  // Commands first: an explicit tag wins (D3), so suggestions dedup against it.
  for (const m of late) {
    if (applied.has(m.messageId)) continue;
    const cmd = tags.parse(m.content.trim());
    if (!cmd) continue;
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

  const cursorAdvanced = report.batchFailures === 0 && tagged.failures === 0;
  if (cursorAdvanced) await recordRun(pool, cursorKey(groupId), startedAt);
  return { report, tagged, cursorAdvanced };
}

async function databaseNow(pool: pg.Pool): Promise<Date> {
  const { rows } = await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t");
  return rows[0]!.t;
}
