/**
 * commands.ts — apply one explicit @Rosey command to the store.
 *
 * Deterministic: no model is consulted. D3 — an explicit tag always wins:
 *  - adding an item that matches a live SUGGESTION confirms that suggestion
 *    (rather than creating a twin), as a 'tag' event;
 *  - adding an item that is already an open task is a no-op;
 *  - otherwise the item becomes an open task of origin 'tag'.
 * Matching an add is per kind: a command's items are tasks unless it carries a
 * grocery prefix, and are compared only with live items of that kind. A
 * command never changes the kind of an item it matches.
 *
 * "done" resolves to exactly one live task or does nothing: an ambiguous match
 * is reported back to the caller, never guessed. Quoting the message a task came
 * from narrows the match to that message's tasks.
 */

import type { RoseyTask, StatusEventResult } from "../db/repositories/rosey-tasks.js";
import type { RoseyItemKind } from "./kind.js";
import type { RoseyCommand } from "./tags.js";
import { titleKey } from "./text.js";

/** Explicit items are compared only to tasks raised this recently (see aggregate.ts). */
export const TAG_DEDUP_WINDOW_DAYS = 14;

export type CommandContext = {
  groupId: number;
  /** The DB id of the message carrying the command. */
  messageId: number;
  sentAt: Date;
  /** DB id of the message this one quotes, when it is a reply. */
  quotedMessageId: number | null;
};

export type CommandStore = {
  /** Live (suggested/open) items of the group raised within [since, until]; one kind, or both. */
  liveTasksRaisedBetween: (since: Date, until: Date, kind?: RoseyItemKind) => Promise<RoseyTask[]>;
  insertTagged: (input: {
    title: string;
    titleKey: string;
    kind: RoseyItemKind;
    sourceMessageId: number;
    sourceItemIndex: number;
    raisedAt: Date;
  }) => Promise<number | null>;
  markStatus: (input: {
    taskId: number;
    status: "open" | "done";
    sourceMessageId: number;
  }) => Promise<StatusEventResult>;
};

export type CommandOutcome =
  | { kind: "added"; created: number; confirmed: number; alreadyOpen: number }
  | { kind: "done"; taskId: number }
  /** The task was found, but its status is not the chat's to change (D4: set by hand). */
  | { kind: "done_refused"; taskId: number }
  | { kind: "done_no_match" }
  | { kind: "done_ambiguous"; candidates: number };

/** Does `query` pick out `task`? Exact key, or one contains the other. */
function matches(task: RoseyTask, queryKey: string): boolean {
  if (task.titleKey === queryKey) return true;
  if (queryKey.length < 2) return false;
  return task.titleKey.includes(queryKey) || queryKey.includes(task.titleKey);
}

export async function applyCommand(
  cmd: RoseyCommand,
  ctx: CommandContext,
  store: CommandStore,
): Promise<CommandOutcome> {
  if (cmd.kind === "add") {
    const out = { kind: "added" as const, created: 0, confirmed: 0, alreadyOpen: 0 };
    const since = new Date(ctx.sentAt.getTime() - TAG_DEDUP_WINDOW_DAYS * 86_400_000);
    for (const [index, title] of cmd.items.entries()) {
      const key = titleKey(title);
      if (!key) continue;
      const live = await store.liveTasksRaisedBetween(since, ctx.sentAt, cmd.itemKind);
      const same = live.find((t) => t.titleKey === key);
      if (same?.status === "suggested") {
        await store.markStatus({ taskId: same.id, status: "open", sourceMessageId: ctx.messageId });
        out.confirmed++;
      } else if (same) {
        out.alreadyOpen++;
      } else {
        const id = await store.insertTagged({
          title,
          titleKey: key,
          kind: cmd.itemKind,
          sourceMessageId: ctx.messageId,
          sourceItemIndex: index,
          raisedAt: ctx.sentAt,
        });
        if (id === null) out.alreadyOpen++;
        else out.created++;
      }
    }
    return out;
  }

  // done: every live item of either kind, any age — completing an old task is
  // the common case, and a grocery item is bought (done) like any other.
  let candidates = await store.liveTasksRaisedBetween(new Date(0), ctx.sentAt);
  if (ctx.quotedMessageId !== null) {
    candidates = candidates.filter((t) => t.sourceMessageId === ctx.quotedMessageId);
  }
  const queryKey = titleKey(cmd.query);
  if (queryKey) candidates = candidates.filter((t) => matches(t, queryKey));
  else if (ctx.quotedMessageId === null) return { kind: "done_no_match" };
  // An exact title beats containment: "חלב" must not be ambiguous with "חלב סויה"
  // when a task literally named "חלב" exists.
  const exact = candidates.filter((t) => t.titleKey === queryKey);
  const pick = exact.length === 1 ? exact : candidates;
  if (pick.length === 0) return { kind: "done_no_match" };
  if (pick.length > 1) return { kind: "done_ambiguous", candidates: pick.length };
  const task = pick[0]!;
  const marked = await store.markStatus({
    taskId: task.id,
    status: "done",
    sourceMessageId: ctx.messageId,
  });
  // Recorded either way (the event log keeps the refused act); reported as it is.
  return marked.found && marked.applied
    ? { kind: "done", taskId: task.id }
    : { kind: "done_refused", taskId: task.id };
}
