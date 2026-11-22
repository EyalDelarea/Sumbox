/**
 * engine.ts — Rosey's live engine: capture + debounced suggestions, bound to
 * the real database and local Ollama, with the transport handed in.
 *
 * It loads no WhatsApp code at runtime (Baileys' types only), so the sandbox
 * (src/ops/rosey-sandbox) runs exactly this engine with no session in reach.
 * The collector's entry, live.ts, supplies the WhatsApp message-id generator
 * and the session's sender.
 *
 * The collector hands every message here AFTER ingest. Explicit @Rosey commands
 * apply at once; ordinary messages only (re)arm the group's suggestion timer,
 * and when a group goes quiet for `suggestDebounceMs` the SAME aggregation the
 * CLI backfill runs reads what is new since its cursor.
 *
 * Why debounced and not per message:
 *  - a list is usually typed over several messages, and the model needs them
 *    together;
 *  - @Aida's replies and /סיכום posts echo back as ordinary `from_me` messages,
 *    and their `aida_messages` marker is written only after the send resolves.
 *    Reading minutes later, the marker is there, so a bot's words are never
 *    mined as the owner's tasks.
 *
 * Everything per group runs through one never-dropping serial queue, so a
 * command and a suggestion pass on the same group never interleave.
 *
 * A list request ("@Rosey מה המשימות?") goes to her send gate (reply.ts) on a
 * queue of its own, so a reply never waits minutes behind a suggestion pass,
 * and two replies to one group never race the rate-limit count.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { isAidaMessage } from "../db/repositories/aida-messages.js";
import {
  getEnabledGroupJids,
  ROSEY_COMMAND_KEY,
} from "../db/repositories/group-command-permissions.js";
import { getMessageIdByExternalId } from "../db/repositories/messages.js";
import {
  countRoseyMessagesSince,
  groupIdForJid,
  isRoseyPost,
  jidForGroupId,
  listTasks,
  pollTaskIds,
  reconcileRoseyMessageId,
  recordRoseyMessage,
  recordRoseyPoll,
  recordStatusEvent,
  tasksDoneSince,
} from "../db/repositories/rosey-tasks.js";
import { type CaptureResult, captureMessage, quotedStanzaId } from "./capture.js";
import { applyCommand } from "./commands.js";
import type { RoseyConfig } from "./config.js";
import {
  applyPollVote,
  type PollVoteOutcome,
  PollVotes,
  type RoseyPollSender,
  replyWithPolls,
} from "./poll.js";
import {
  DONE_WINDOW_MS,
  type ListReplyOutcome,
  type RoseySender,
  replyWithList,
  SEND_TIMEOUT_MS,
} from "./reply.js";
import { commandStore, type Generate, makeGenerate, runAggregation } from "./run.js";
import { GroupSerialQueue } from "./serial-queue.js";
import { makeTagMatcher } from "./tags.js";

/** How far back a live suggestion pass may read (the cursor bounds it further). */
export const LIVE_SUGGEST_DAYS = 14;

/**
 * How long a from_me command waits before @Aida's marker is read. Her marker is
 * written right after her send resolves; the echo of that send can reach the
 * collector first. Only the owner's own commands pay this.
 */
export const OWN_ECHO_GRACE_MS = 5_000;

/**
 * A pass holds its cursor only for messages registered by this long after it
 * began. Registration follows ingest within a tick, so a message registered
 * later was ingested after the pass took its cursor and cannot be passed by it;
 * holding for it too would starve a busy group's cursor.
 */
export const REGISTRATION_SLACK_MS = 1_000;

type Log = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type RoseyLive = {
  onMessage: (msg: WAMessage) => Promise<void>;
  /**
   * Run a group's suggestion pass now instead of after the quiet period: its
   * pending timer is cancelled and the SAME queued pass runs. Resolves when the
   * pass has finished (failures are logged, never thrown).
   */
  suggestNow: (groupId: number) => Promise<void>;
  /**
   * A vote on one of her list polls: `selected` is the voter's WHOLE current
   * selection (option indexes), as WhatsApp sends it. Runs on the group's queue,
   * like a command; a chat not on her list changes nothing.
   */
  onPollVote: (vote: {
    jid: string;
    pollId: string;
    voter: string;
    selected: readonly number[];
  }) => Promise<PollVoteOutcome | { kind: "not_enabled" }>;
  /** Cancel pending suggestion timers (in-flight work finishes on its own). */
  stop: () => void;
};

export type RoseyEngineDeps = {
  pool: pg.Pool;
  cfg: RoseyConfig;
  log?: Log;
  /** Injectable for tests; defaults to the local Ollama model. */
  generate?: Generate;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable for tests; defaults to OWN_ECHO_GRACE_MS. */
  ownEchoGraceMs?: number;
  /** Injectable for tests; defaults to REGISTRATION_SLACK_MS. */
  registrationSlackMs?: number;
  /** The collector's session, for her one reply. Absent: the gate sends nothing. */
  sender?: RoseySender;
  /** Injectable for tests; defaults to reply.ts's SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
  /**
   * The poll transport (D8). With it, and `listStyle` answering "poll", a list
   * request is answered with checklist polls; otherwise with the text list.
   */
  pollSender?: RoseyPollSender;
  /**
   * Who has ticked what on her polls. Injectable so a host can show the ticks
   * from the one record the vote path keeps; a fresh one otherwise.
   */
  pollVotes?: PollVotes;
  /** How a list request is answered, read per request; defaults to "text". */
  listStyle?: () => "text" | "poll";
  /** A fresh WhatsApp message id for one of her posts, known before it is sent. */
  newMessageId: () => string;
  /** Told what capture decided for each message (ids and outcomes, never text). */
  onCapture?: (externalId: string, result: CaptureResult) => void;
};

export function makeRoseyEngine(deps: RoseyEngineDeps): RoseyLive {
  const { pool, cfg, log } = deps;
  const clock = deps.now ?? Date.now;
  const generate = deps.generate ?? makeGenerate(cfg);
  const matcher = makeTagMatcher(cfg.tags);
  const queue = new GroupSerialQueue();
  // Arrival order per chat. Each message's gate reads (allowlist, group, ids) are
  // awaited before it reaches `queue`, and those can finish out of order; without
  // this, "add X" then "done X" could apply as done-then-add.
  const arrivals = new GroupSerialQueue<string>();
  /** List replies, per group: the rate-limit count and the record never interleave. */
  const replies = new GroupSerialQueue();
  const roseyJids = async () => new Set(await getEnabledGroupJids(pool, ROSEY_COMMAND_KEY));
  const timers = new Map<number, NodeJS.Timeout>();
  /** When each group's pending pass was first deferred (the debounce cap). */
  const firstDeferred = new Map<number, number>();
  let stopped = false;
  /**
   * Every message the live path is handling or has decided, by WhatsApp id,
   * registered on ARRIVAL — before any lookup — so a pass that reads a message
   * still in flight never replays it behind the live path's back.
   *
   * - pending: still in capture. The catch-up skips it, and a pass that began
   *   while it was pending holds its cursor until it ends.
   * - decided: the live path took it as a command and finished (applied, or
   *   decided without effect). The catch-up never replays it; it is forgotten
   *   once a pass of its group moves the cursor past it.
   * - anything else (a throw before the command applied, a stale replay, a
   *   failed allowlist read, chatter) leaves the registry, so the catch-up sees
   *   it like any other message — except a QUOTED command the catch-up would
   *   have to replay: the catch-up cannot see quotes, so replaying it could close
   *   a task the sender never pointed at. It is kept as decided, and logged.
   * - a second delivery of an id already registered is ignored.
   *
   * In memory only: a restart forgets it, so a command decided without effect
   * (no match) just before a restart is tried once more by the next pass.
   */
  type Handling = {
    /** The chat it came from: matches a pass while its group is not resolved. */
    chat: string;
    groupId: number | null;
    state: "pending" | "decided" | "released";
    /** Date.now() at registration. */
    registeredAt: number;
  };
  const handling = new Map<string, Handling>();
  /** Running passes, told of each message released to the catch-up. */
  const watchers = new Set<(h: Handling) => void>();
  const release = (id: string, h: Handling, replay: boolean) => {
    h.state = "released";
    if (handling.get(id) === h) handling.delete(id);
    if (!replay) return;
    for (const w of watchers) w(h);
    // Its group's catch-up must run even if the chat then goes quiet.
    if (h.groupId !== null) scheduleSuggestions(h.groupId);
  };
  const slackMs = deps.registrationSlackMs ?? REGISTRATION_SLACK_MS;
  const graceMs = deps.ownEchoGraceMs ?? OWN_ECHO_GRACE_MS;

  const suggestNow = (groupId: number) =>
    queue
      .run(groupId, async () => {
        const jid = await jidForGroupId(pool, groupId);
        // Re-checked when the pass runs: one armed before `rosey disable` must not
        // replay what was said after it (the live path ignored those, so the
        // catch-up would see them as unapplied commands).
        const enabled = new Set(await getEnabledGroupJids(pool, ROSEY_COMMAND_KEY));
        if (jid === null || !enabled.has(jid)) return null;
        const cutoff = Date.now() + slackMs;
        // A message whose group is not resolved yet is ours only if it came from
        // this group's chat, so one chat's failure never holds another's cursor.
        const ours = (h: Handling) =>
          (h.groupId === groupId || (h.groupId === null && h.chat === jid)) &&
          h.registeredAt <= cutoff;
        const decided = [...handling].filter(([, h]) => ours(h) && h.state === "decided");
        let releasedDuring = false;
        const watch = (h: Handling) => {
          if (ours(h)) releasedDuring = true;
        };
        watchers.add(watch);
        const result = await runAggregation(pool, groupId, {
          cfg,
          generate,
          days: LIVE_SUGGEST_DAYS,
          skipCommand: (m) => m.externalId !== null && handling.has(m.externalId),
          // Judged when the pass ENDS: a message the pass skipped as pending may
          // still turn out to need the catch-up (its apply threw), and the new
          // cursor must not pass it. So hold while any of this group's messages
          // from before the cutoff is pending, or was released to the catch-up
          // during the pass. The cost: such a pass re-reads its window next time.
          holdCursor: () =>
            releasedDuring || [...handling.values()].some((h) => ours(h) && h.state === "pending"),
          onBatchError: (err, b) =>
            log?.warn(
              { err, groupId, batch: b.index, size: b.size },
              "rosey: suggestion batch failed",
            ),
          onCommandError: (err, messageId) =>
            log?.warn({ err, groupId, messageId }, "rosey: replayed command failed; will retry"),
        }).finally(() => watchers.delete(watch));
        if (result.cursorAdvanced) {
          for (const [id, h] of decided) if (handling.get(id) === h) handling.delete(id);
        }
        return result;
      })
      .then((result) => {
        if (result === null) {
          log?.info({ groupId }, "rosey: pass skipped; group not enabled");
          return;
        }
        const { report, tagged, cursorAdvanced } = result;
        log?.info(
          {
            groupId,
            cursorAdvanced,
            read: report.messagesRead,
            created: report.created,
            merged: report.merged,
            dedupUnparsed: report.dedupUnparsed,
            rejected: report.rejected,
            raisedByUnresolved: report.raisedByUnresolved,
            failures: report.batchFailures,
            tagged,
          },
          cursorAdvanced
            ? "rosey: suggestion pass"
            : "rosey: suggestion pass incomplete; will retry",
        );
      })
      .catch((err: unknown) => log?.error({ err, groupId }, "rosey: suggestion pass failed"));

  const scheduleSuggestions = (groupId: number) => {
    if (stopped) return;
    clearTimeout(timers.get(groupId));
    // Debounced, but capped: a group that is never quiet for the full debounce
    // still gets a pass within 4x of it.
    const now = Date.now();
    const first = firstDeferred.get(groupId) ?? now;
    firstDeferred.set(groupId, first);
    const wait = Math.max(
      0,
      Math.min(cfg.suggestDebounceMs, first + 4 * cfg.suggestDebounceMs - now),
    );
    const t = setTimeout(() => {
      timers.delete(groupId);
      firstDeferred.delete(groupId);
      void suggestNow(groupId);
    }, wait);
    t.unref?.();
    timers.set(groupId, t);
  };

  const votes = deps.pollVotes ?? new PollVotes();

  return {
    onPollVote: async (vote) => {
      const enabled = await roseyJids();
      const groupId = enabled.has(vote.jid) ? await groupIdForJid(pool, vote.jid) : null;
      if (groupId === null) return { kind: "not_enabled" };
      const out = await queue.run(groupId, () =>
        applyPollVote(
          {
            pollTaskIds: (g, pollId) => pollTaskIds(pool, g, pollId),
            markStatus: ({ taskId, status }) =>
              recordStatusEvent(pool, { taskId, status, source: "poll", groupId }),
          },
          votes,
          { groupId, pollId: vote.pollId, voter: vote.voter, selected: vote.selected },
        ),
      );
      // Ids and statuses only — never an option's text.
      log?.info({ groupId, pollId: vote.pollId, out }, "rosey: poll vote");
      return out;
    },
    suggestNow: (groupId) => {
      clearTimeout(timers.get(groupId));
      timers.delete(groupId);
      firstDeferred.delete(groupId);
      return suggestNow(groupId);
    },
    onMessage: async (msg) => {
      if (stopped) return;
      const chat = msg.key?.remoteJid ?? "";
      // Liveness is judged at ARRIVAL. A message can wait in `arrivals` behind a
      // command that waits behind a minutes-long suggestion pass; judged when it
      // finally runs, a live command would read as a replay and wait for the
      // next pass instead of applying now.
      const arrivedAt = clock();
      const id = msg.key?.id ?? "";
      if (id && handling.has(id)) return; // a second delivery: already handled
      const h: Handling = { chat, groupId: null, state: "pending", registeredAt: Date.now() };
      if (id) handling.set(id, h);
      /** A quoted message is never released for a replay (see the registry). */
      const releaseOrKeep = (replay: boolean) => {
        if (replay && quotedStanzaId(msg) !== null) {
          h.state = "decided";
          log?.warn(
            { groupId: h.groupId },
            "rosey: quoted command not applied; not replayed, its quote would be lost",
          );
        } else release(id, h, replay);
      };
      let claimed = false;
      let applied = false;
      await arrivals.run(chat, () =>
        captureMessage(msg, {
          now: () => arrivedAt,
          matcher,
          resolveEnabledJids: roseyJids,
          groupIdForJid: async (jid) => {
            h.groupId = await groupIdForJid(pool, jid);
            return h.groupId;
          },
          messageIdFor: async (groupId, externalId) =>
            (await getMessageIdByExternalId(pool, groupId, externalId))?.id ?? null,
          isOwnPost: (groupId, externalId) => isRoseyPost(pool, groupId, externalId),
          isAidaPost: (groupId, externalId) => isAidaMessage(pool, { groupId, externalId }),
          ownEchoGrace: () => new Promise((r) => setTimeout(r, graceMs)),
          claimCommand: () => {
            claimed = true;
          },
          applyCommand: async (cmd, ctx) => {
            const out = await queue.run(ctx.groupId, () =>
              applyCommand(cmd, ctx, commandStore(pool, ctx.groupId)),
            );
            applied = true;
            return out;
          },
          scheduleSuggestions,
          replyList: (req) =>
            replies.run(req.groupId, async () => {
              if ((deps.listStyle?.() ?? "text") === "poll" && deps.pollSender) {
                const polls = await replyWithPolls(
                  {
                    mode: cfg.sendMode,
                    resolveEnabledJids: roseyJids,
                    countPollsSince: (g, since) => countRoseyMessagesSince(pool, g, "poll", since),
                    loadLive: (g) => listTasks(pool, g),
                    record: (g, poll) => recordRoseyPoll(pool, { groupId: g, ...poll }),
                    newMessageId: deps.newMessageId,
                    sendTimeoutMs: deps.sendTimeoutMs ?? SEND_TIMEOUT_MS,
                    sender: deps.pollSender,
                    now: Date.now,
                    log,
                  },
                  { jid: req.jid, groupId: req.groupId, quoted: req.request },
                );
                // Nothing open: no checklist to post, so the text list says so.
                if (polls.kind !== "skipped" || polls.reason !== "nothing_open") return polls;
              }
              return replyWithList(
                {
                  mode: cfg.sendMode,
                  resolveEnabledJids: roseyJids,
                  countRepliesSince: (g, since) => countRoseyMessagesSince(pool, g, "reply", since),
                  loadList: async (g, now) => ({
                    live: await listTasks(pool, g),
                    doneRecently: await tasksDoneSince(
                      pool,
                      g,
                      new Date(now.getTime() - DONE_WINDOW_MS),
                    ),
                  }),
                  record: (g, externalId) =>
                    recordRoseyMessage(pool, { groupId: g, externalId, kind: "reply" }),
                  reconcile: (g, chosen, reported) =>
                    reconcileRoseyMessageId(pool, g, chosen, reported),
                  newMessageId: deps.newMessageId,
                  sendTimeoutMs: deps.sendTimeoutMs,
                  sender: deps.sender,
                  now: Date.now,
                  log,
                },
                { jid: req.jid, groupId: req.groupId, quoted: req.request },
              );
            }) as Promise<ListReplyOutcome>,
          log,
        }).then(
          (r) => {
            deps.onCapture?.(id, r);
            // A list request stays registered as decided, so a second delivery
            // of it (WhatsApp re-emits a message) never gets a second reply.
            if (claimed || r.kind === "list") h.state = "decided";
            else
              releaseOrKeep(
                r.kind === "ignored" && (r.reason === "stale" || r.reason === "allowlist_error"),
              );
          },
          (err: unknown) => {
            // Thrown before any command applied: the catch-up must see it.
            if (claimed && applied) h.state = "decided";
            else releaseOrKeep(true);
            throw err;
          },
        ),
      );
    },
    stop: () => {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      firstDeferred.clear();
      handling.clear();
    },
  };
}
