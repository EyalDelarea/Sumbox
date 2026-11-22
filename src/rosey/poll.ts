/**
 * poll.ts — Rosey's list as WhatsApp polls (D8): a multi-select CHECKLIST per
 * list, where ticking an option marks its task done.
 *
 * Three parts, all transport-free:
 *  1. buildListPolls — the payloads: open tasks under "📋 המשימות שלנו", open
 *     groceries under "🛒 קניות", at most MAX_POLL_OPTIONS options per poll (a
 *     longer list splits into several polls).
 *  2. replyWithPolls — her send gate for polls, the same gate as the text list
 *     (reply.ts): ROSEY_SEND_MODE, a group chat, her own allowlist re-read now,
 *     rate limits (counted in poll posts), and no "@" anywhere. Each poll is
 *     recorded BEFORE it leaves: one rosey_messages row for the poll (kind
 *     'poll', with its message secret) and one per option, keyed
 *     `<poll id>#<option index>#<option text>` with the option's task_id. That ledger is how a
 *     vote is mapped back to a task, with no schema change.
 *  3. applyPollVote — a vote (poll id, voter, the options that voter now has
 *     ticked) in, status events out, through the poll layer of D4 (status.ts):
 *     an option ticked by its first voter marks its task done; an option left
 *     with no voter reopens it, but only if a poll closed it (D4, status.ts:
 *     a tag or reply after the tick wins). A manual status is never moved.
 *
 * What a real WhatsApp send still needs (not here): the Baileys poll send, which
 * must carry the secret recorded here, and vote decryption — a pollUpdateMessage
 * is encrypted with that secret and names options by the SHA-256 of their text.
 */

import { randomBytes } from "node:crypto";
import type { WAMessage } from "@whiskeysockets/baileys";
import { matchAskTrigger } from "../collector/ask-trigger.js";
import type { RoseyTask, StatusEventResult } from "../db/repositories/rosey-tasks.js";
import type { RoseyItemKind } from "./kind.js";
import {
  cleanTitle,
  type ListReplyOutcome,
  type ListReplySkip,
  type RoseySendMode,
} from "./reply.js";

// ── The payloads ──────────────────────────────────────────────────────────────

/** WhatsApp's cap on options in one poll. */
export const MAX_POLL_OPTIONS = 12;
/** An option is one line on a phone; a longer title is cut. */
export const MAX_OPTION_CHARS = 100;

export const TASKS_POLL_NAME = "📋 המשימות שלנו";
export const GROCERY_POLL_NAME = "🛒 קניות";

export type PollPayload = {
  /** The poll's question. */
  name: string;
  /** Option texts, unique within the poll (WhatsApp names a voted option by its text). */
  options: string[];
  /** The task each option stands for, by index. */
  taskIds: number[];
  kind: RoseyItemKind;
};

const byRaised = (a: RoseyTask, b: RoseyTask) =>
  a.raisedAt.getTime() - b.raisedAt.getTime() || a.id - b.id;

function optionText(title: string): string {
  const t = cleanTitle(title);
  return t.length > MAX_OPTION_CHARS ? `${t.slice(0, MAX_OPTION_CHARS - 1)}…` : t;
}

/** Make every option distinct: a repeated text gets " (2)", " (3)", … */
function unique(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return n === 1 ? t : `${t} (${n})`;
  });
}

function pollsOf(kind: RoseyItemKind, name: string, open: RoseyTask[]): PollPayload[] {
  const items = open.filter((t) => t.kind === kind).sort(byRaised);
  const chunks: RoseyTask[][] = [];
  for (let i = 0; i < items.length; i += MAX_POLL_OPTIONS) {
    chunks.push(items.slice(i, i + MAX_POLL_OPTIONS));
  }
  return chunks.map((chunk, i) => ({
    name: chunks.length > 1 ? `${name} (${i + 1}/${chunks.length})` : name,
    options: unique(chunk.map((t) => optionText(t.title))),
    taskIds: chunk.map((t) => t.id),
    kind,
  }));
}

/**
 * The list as polls: OPEN items only (a suggestion nobody confirmed is not a
 * checklist item), tasks first, then groceries, oldest raised first. Empty when
 * nothing is open.
 */
export function buildListPolls(live: readonly RoseyTask[]): PollPayload[] {
  const open = live.filter((t) => t.status === "open");
  return [
    ...pollsOf("task", TASKS_POLL_NAME, open),
    ...pollsOf("grocery", GROCERY_POLL_NAME, open),
  ];
}

// ── The gate ──────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/**
 * Per group, poll POSTS (a list of 30 items is 3 posts): at most 12 an hour and
 * 40 a day. Counted from the ledger, so a restart does not reset them. A list
 * that would cross a limit is not sent at all — never half a list.
 */
export const POLL_POST_LIMITS: readonly { windowMs: number; max: number }[] = [
  { windowMs: HOUR, max: 12 },
  { windowMs: 24 * HOUR, max: 40 },
];

/** A message secret is 32 random bytes (what WhatsApp's poll encryption keys on). */
export const POLL_SECRET_BYTES = 32;

/** The one poll send Rosey is handed: a poll quoting the request, under a chosen id and secret. */
export type RoseyPollSender = {
  sendPoll: (
    jid: string,
    poll: { name: string; options: string[]; selectableCount: number },
    opts: { quoted?: WAMessage; messageId: string; messageSecret: Uint8Array },
  ) => Promise<WAMessage | undefined>;
};

type Log = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type PollReplyDeps = {
  mode: RoseySendMode;
  resolveEnabledJids: () => Promise<ReadonlySet<string>>;
  /** Her poll posts to this group at or after `since` (rosey_messages). */
  countPollsSince: (groupId: number, since: Date) => Promise<number>;
  loadLive: (groupId: number) => Promise<RoseyTask[]>;
  /** Record a poll and its options. Called BEFORE the send; throwing sends nothing. */
  record: (
    groupId: number,
    poll: { externalId: string; secret: Uint8Array; taskIds: number[]; options: string[] },
  ) => Promise<void>;
  newMessageId: () => string;
  /** Injectable for tests; defaults to 32 random bytes. */
  newSecret?: () => Uint8Array;
  sendTimeoutMs: number;
  sender: RoseyPollSender | undefined;
  now: () => number;
  log?: Log;
};

/**
 * Answer one list request with polls, if the gate allows it. Run it inside the
 * group's reply queue, like replyWithList. With nothing open there is no poll
 * to send: the outcome says so and the caller may answer in text instead.
 */
export async function replyWithPolls(
  deps: PollReplyDeps,
  req: { jid: string; groupId: number; quoted: WAMessage },
): Promise<ListReplyOutcome> {
  const skip = (reason: ListReplySkip): ListReplyOutcome => {
    deps.log?.info({ groupId: req.groupId, reason }, "rosey: list polls not sent");
    return { kind: "skipped", reason };
  };
  if (deps.mode === "off") return skip("off");
  if (!req.jid.endsWith("@g.us")) return skip("not_a_group");
  let enabled: ReadonlySet<string>;
  try {
    enabled = await deps.resolveEnabledJids();
  } catch (err) {
    deps.log?.warn({ err, groupId: req.groupId }, "rosey: allowlist read failed; polls blocked");
    return skip("allowlist_error");
  }
  if (!enabled.has(req.jid)) return skip("not_enabled");

  const polls = buildListPolls(await deps.loadLive(req.groupId));
  if (polls.length === 0) return skip("nothing_open");

  const now = deps.now();
  for (const limit of POLL_POST_LIMITS) {
    const sent = await deps.countPollsSince(req.groupId, new Date(now - limit.windowMs));
    if (sent + polls.length > limit.max) return skip("rate_limited");
  }
  const texts = polls.flatMap((p) => [p.name, ...p.options]);
  if (texts.some((t) => /[@＠]/.test(t) || matchAskTrigger(t))) return skip("unsafe_text");

  if (deps.mode === "dry-run") {
    deps.log?.info(
      { groupId: req.groupId, polls: polls.map((p) => ({ name: p.name, options: p.options })) },
      "rosey: dry-run list polls (not sent)",
    );
    return { kind: "dry_run", chars: texts.join("\n").length };
  }
  if (!deps.sender) return skip("no_sender");

  const externalIds: string[] = [];
  for (const poll of polls) {
    const externalId = deps.newMessageId();
    const secret = deps.newSecret?.() ?? randomBytes(POLL_SECRET_BYTES);
    try {
      await deps.record(req.groupId, {
        externalId,
        secret,
        taskIds: poll.taskIds,
        options: poll.options,
      });
    } catch (err) {
      deps.log?.error({ err, groupId: req.groupId }, "rosey: list poll not recorded; not sent");
      return { kind: "failed" };
    }
    const send = deps.sender.sendPoll(
      req.jid,
      { name: poll.name, options: poll.options, selectableCount: 0 },
      { quoted: req.quoted, messageId: externalId, messageSecret: secret },
    );
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), deps.sendTimeoutMs);
    });
    try {
      if ((await Promise.race([send, timedOut])) === "timed_out") {
        send.catch((err: unknown) =>
          deps.log?.error(
            { err, groupId: req.groupId, externalId },
            "rosey: timed-out poll failed",
          ),
        );
        deps.log?.error({ groupId: req.groupId, externalId }, "rosey: list poll send timed out");
        return { kind: "timed_out" };
      }
    } catch (err) {
      deps.log?.error({ err, groupId: req.groupId, externalId }, "rosey: list poll failed to send");
      return { kind: "failed" };
    } finally {
      clearTimeout(timer);
    }
    externalIds.push(externalId);
  }
  deps.log?.info({ groupId: req.groupId, polls: externalIds.length }, "rosey: list polls sent");
  return { kind: "polls_sent", externalIds };
}

// ── Votes ─────────────────────────────────────────────────────────────────────

/**
 * Who has ticked what, per poll. WhatsApp delivers a vote as the voter's WHOLE
 * current selection, so the previous selection is needed to see what changed.
 *
 * In memory only, and nothing else records votes: a restart forgets every
 * selection, after which an untick looks like no change and reopens nothing.
 * The real WhatsApp slice needs a persisted vote store first, which is a
 * schema change of its own.
 */
export class PollVotes {
  private readonly polls = new Map<string, Map<string, ReadonlySet<number>>>();

  /** Set a voter's selection; returns what it was before. */
  set(pollId: string, voter: string, selected: ReadonlySet<number>): ReadonlySet<number> {
    const voters = this.polls.get(pollId) ?? new Map<string, ReadonlySet<number>>();
    this.polls.set(pollId, voters);
    const before = voters.get(voter) ?? new Set<number>();
    voters.set(voter, selected);
    return before;
  }

  /** One voter's current selection on a poll (empty when they never voted). */
  selection(pollId: string, voter: string): ReadonlySet<number> {
    return this.polls.get(pollId)?.get(voter) ?? new Set<number>();
  }

  /** Every voter on one option of a poll. */
  votersOf(pollId: string, option: number): string[] {
    return [...(this.polls.get(pollId) ?? new Map<string, ReadonlySet<number>>())]
      .filter(([, sel]) => sel.has(option))
      .map(([voter]) => voter);
  }
}

export type PollVoteStore = {
  /** The task behind each option of one of her polls in this group, or null if not hers. */
  pollTaskIds: (groupId: number, pollId: string) => Promise<(number | null)[] | null>;
  /** A status event from a poll vote (source 'poll', D4's chat layer). */
  markStatus: (input: { taskId: number; status: "done" | "open" }) => Promise<StatusEventResult>;
};

export type PollVoteEffect = {
  option: number;
  taskId: number;
  status: "done" | "open";
  result: StatusEventResult;
};

export type PollVoteOutcome =
  | { kind: "unknown_poll" }
  | { kind: "applied"; effects: PollVoteEffect[] };

/**
 * One voter's vote on one of her polls. Only what this vote changed is acted
 * on: an option this voter newly ticked marks its task done; an option this
 * voter un-ticked asks to reopen its task once nobody has it ticked, which
 * the store applies only if a poll set the current status. Options outside
 * the poll are ignored.
 */
export async function applyPollVote(
  store: PollVoteStore,
  votes: PollVotes,
  vote: { groupId: number; pollId: string; voter: string; selected: readonly number[] },
): Promise<PollVoteOutcome> {
  const taskIds = await store.pollTaskIds(vote.groupId, vote.pollId);
  if (taskIds === null) return { kind: "unknown_poll" };
  const selected = new Set(vote.selected.filter((i) => i >= 0 && i < taskIds.length));
  const before = votes.set(vote.pollId, vote.voter, selected);
  const effects: PollVoteEffect[] = [];
  try {
    for (let option = 0; option < taskIds.length; option++) {
      const taskId = taskIds[option];
      if (taskId === null || taskId === undefined) continue; // its task was deleted
      const ticked = selected.has(option) && !before.has(option);
      const unticked = !selected.has(option) && before.has(option);
      if (!ticked && !unticked) continue;
      // Done on its FIRST tick and reopened when its LAST one goes: a second
      // voter adds no event.
      const voters = votes.votersOf(vote.pollId, option).length;
      if ((ticked && voters > 1) || (unticked && voters > 0)) continue;
      const status = ticked ? "done" : "open";
      effects.push({ option, taskId, status, result: await store.markStatus({ taskId, status }) });
    }
  } catch (err) {
    // Forget this vote, so the same vote arriving again is a change again and
    // retries what failed (rather than looking already applied).
    votes.set(vote.pollId, vote.voter, before);
    throw err;
  }
  return { kind: "applied", effects };
}
