/**
 * live.ts — Rosey wired into a running collector: capture + debounced
 * suggestions, bound to the real database and local Ollama.
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
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { isAidaMessage } from "../db/repositories/aida-messages.js";
import {
  getEnabledGroupJids,
  ROSEY_COMMAND_KEY,
} from "../db/repositories/group-command-permissions.js";
import { getMessageIdByExternalId } from "../db/repositories/messages.js";
import { groupIdForJid, isRoseyPost } from "../db/repositories/rosey-tasks.js";
import { captureMessage } from "./capture.js";
import { applyCommand } from "./commands.js";
import { loadRoseyConfig, type RoseyConfig } from "./config.js";
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

type Log = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type RoseyLive = {
  onMessage: (msg: WAMessage) => Promise<void>;
  /** Cancel pending suggestion timers (in-flight work finishes on its own). */
  stop: () => void;
};

export function makeRoseyLive(deps: {
  pool: pg.Pool;
  cfg: RoseyConfig;
  log?: Log;
  /** Injectable for tests; defaults to the local Ollama model. */
  generate?: Generate;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable for tests; defaults to OWN_ECHO_GRACE_MS. */
  ownEchoGraceMs?: number;
}): RoseyLive {
  const { pool, cfg, log } = deps;
  const clock = deps.now ?? Date.now;
  const generate = deps.generate ?? makeGenerate(cfg);
  const matcher = makeTagMatcher(cfg.tags);
  const queue = new GroupSerialQueue();
  // Arrival order per chat. Each message's gate reads (allowlist, group, ids) are
  // awaited before it reaches `queue`, and those can finish out of order; without
  // this, "add X" then "done X" could apply as done-then-add.
  const arrivals = new GroupSerialQueue<string>();
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
   * - anything else (a throw before the command applied, a stale replay, chatter)
   *   leaves the registry, so the catch-up sees it like any other message.
   *
   * In memory only: a restart forgets it, so a command decided without effect
   * (no match) just before a restart is tried once more by the next pass.
   */
  type Handling = {
    groupId: number | null;
    state: "pending" | "decided" | "released";
    /** Released to the catch-up: a command it must still replay. */
    replay: boolean;
  };
  const handling = new Map<string, Handling>();
  const release = (id: string, h: Handling, replay: boolean) => {
    h.state = "released";
    h.replay = replay;
    if (handling.get(id) === h) handling.delete(id);
  };
  const graceMs = deps.ownEchoGraceMs ?? OWN_ECHO_GRACE_MS;

  const suggestNow = (groupId: number) =>
    queue
      .run(groupId, async () => {
        // Snapshot at pass start; null groupId = not yet resolved, maybe this one.
        const ours = [...handling].filter(([, h]) => h.groupId === groupId || h.groupId === null);
        const decided = ours.filter(([, h]) => h.state === "decided");
        const pending = ours.filter(([, h]) => h.state === "pending").map(([, h]) => h);
        const result = await runAggregation(pool, groupId, {
          cfg,
          generate,
          days: LIVE_SUGGEST_DAYS,
          skipCommand: (m) => m.externalId !== null && handling.has(m.externalId),
          // A message pending when the pass read may still turn out to need the
          // catch-up (its apply threw); keep it past the cursor until it is known.
          holdCursor: () => pending.some((h) => h.state === "pending" || h.replay),
          onBatchError: (err, b) =>
            log?.warn(
              { err, groupId, batch: b.index, size: b.size },
              "rosey: suggestion batch failed",
            ),
          onCommandError: (err, messageId) =>
            log?.warn({ err, groupId, messageId }, "rosey: replayed command failed; will retry"),
        });
        if (result.cursorAdvanced) {
          for (const [id, h] of decided) if (handling.get(id) === h) handling.delete(id);
        }
        return result;
      })
      .then(({ report, tagged, cursorAdvanced }) =>
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
        ),
      )
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

  return {
    onMessage: async (msg) => {
      if (stopped) return;
      const chat = msg.key?.remoteJid ?? "";
      // Liveness is judged at ARRIVAL. A message can wait in `arrivals` behind a
      // command that waits behind a minutes-long suggestion pass; judged when it
      // finally runs, a live command would read as a replay and wait for the
      // next pass instead of applying now.
      const arrivedAt = clock();
      const id = msg.key?.id ?? "";
      const h: Handling = { groupId: null, state: "pending", replay: false };
      if (id) handling.set(id, h);
      let claimed = false;
      let applied = false;
      await arrivals.run(chat, () =>
        captureMessage(msg, {
          now: () => arrivedAt,
          matcher,
          resolveEnabledJids: async () =>
            new Set(await getEnabledGroupJids(pool, ROSEY_COMMAND_KEY)),
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
          log,
        }).then(
          (r) => {
            if (claimed) h.state = "decided";
            else release(id, h, r.kind === "ignored" && r.reason === "stale");
          },
          (err: unknown) => {
            // Thrown before any command applied: the catch-up must see it.
            if (claimed && applied) h.state = "decided";
            else release(id, h, true);
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

/**
 * The collector's entry point: Rosey's live capture when ROSEY_ENABLED=true,
 * otherwise undefined (attachCollector then never calls her). Off is the default.
 */
export function roseyLiveFromEnv(
  pool: pg.Pool,
  log?: Log,
  env: NodeJS.ProcessEnv = process.env,
): RoseyLive | undefined {
  const cfg = loadRoseyConfig(env);
  if (!cfg.enabled) return undefined;
  log?.info({ tags: cfg.tags, debounceMs: cfg.suggestDebounceMs }, "rosey: live capture on");
  return makeRoseyLive({ pool, cfg, log });
}
