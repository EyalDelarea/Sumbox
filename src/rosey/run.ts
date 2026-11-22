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
      liveTasksRaisedBetween(pool, groupId, since, until, 500),
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
  /** Tagged text messages read in this run. */
  commands: number;
  created: number;
  confirmed: number;
  done: number;
};

export type RunAggregationResult = {
  report: AggregateReport;
  /**
   * Explicit commands found in the read window. The live path applies a command
   * within seconds, but only for a message that arrives live; one sent while the
   * collector was down (or before Rosey was enabled) is applied here instead.
   * Applying twice is harmless: an item's insert is idempotent per (message,
   * index), a confirmed suggestion is already open, and a done task is no longer
   * live to match.
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
  const tagged: TagCatchUp = { commands: 0, created: 0, confirmed: 0, done: 0 };
  const store = commandStore(pool, groupId);
  // Commands first: an explicit tag wins (D3), so suggestions dedup against it.
  for (const m of messages) {
    if (m.isVoice) continue; // a spoken word is not a typed command
    const cmd = tags.parse(m.content.trim());
    if (!cmd) continue;
    tagged.commands++;
    const out = await applyCommand(
      cmd,
      { groupId, messageId: m.messageId, sentAt: m.sentAt, quotedMessageId: null },
      store,
    );
    if (out.kind === "added") {
      tagged.created += out.created;
      tagged.confirmed += out.confirmed;
    } else if (out.kind === "done") {
      tagged.done++;
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

  const cursorAdvanced = report.batchFailures === 0;
  if (cursorAdvanced) await recordRun(pool, cursorKey(groupId), startedAt);
  return { report, tagged, cursorAdvanced };
}

async function databaseNow(pool: pg.Pool): Promise<Date> {
  const { rows } = await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t");
  return rows[0]!.t;
}
