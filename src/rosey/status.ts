/**
 * status.ts — D4, layered status, as one pure decision.
 *
 * The layers are: manual (the owner, locally) > a reply/react/poll on Rosey's
 * own posts > an explicit @Rosey tag > model inference. This file is the reading
 * of D4 that the store enforces:
 *
 *  - `inferred` NEVER changes a status. Measured on the real chat, "done"
 *    evidence is rare (3 of 87 tasks), so inference both misses most completions
 *    and, worse, would flip tasks silently. It is recorded as a hint only.
 *  - `model` only ever CREATES a task (as 'suggested'); it never transitions one.
 *  - 'suggested' is a creation state, never a transition target: once a person
 *    has confirmed or closed a task, nothing turns it back into a guess.
 *  - Every explicit source (manual, tag, reply, react, poll) is a person acting
 *    on purpose, so they apply in TIME ORDER: the latest explicit act wins. A
 *    strict rank (manual always beats a later tag) would mean confirming a task
 *    locally makes it impossible to tick it off from the chat afterwards.
 */

export const TASK_STATUSES = ["suggested", "open", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EVENT_SOURCES = [
  "manual",
  "tag",
  "reply",
  "react",
  "poll",
  "inferred",
  "model",
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

const EXPLICIT: ReadonlySet<EventSource> = new Set(["manual", "tag", "reply", "react", "poll"]);

/** Should an event move a task from `current` to `next`? */
export function shouldApply(current: TaskStatus, next: TaskStatus, source: EventSource): boolean {
  if (!EXPLICIT.has(source)) return false;
  if (next === "suggested") return false;
  return current !== next;
}

export function isTaskStatus(v: string): v is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v);
}
