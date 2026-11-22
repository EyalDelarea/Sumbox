/**
 * status.ts — D4, layered status, as one pure decision.
 *
 * Signed D4: manual > reply/react > inferred. As the store enforces it:
 *
 *  - Layer 3, `manual` (the owner, locally): always wins. A status set by hand
 *    changes only by hand — a later chat act (an @Rosey tag, a reply, a
 *    reaction, a poll vote) never reopens or overrides it. The cost, accepted:
 *    a task opened by hand must also be closed by hand.
 *  - Layer 2, the chat acts — `tag`, `reply`, `react`, `poll`: people acting on
 *    purpose in the group. Within this layer the latest act wins (time order).
 *  - A higher layer re-asserting the CURRENT status still applies: it changes
 *    no status but takes ownership of it. Setting by hand what a tag already
 *    set must lock it as manual, or the next tag would undo a choice the owner
 *    made explicitly.
 *  - Never applied — `inferred` and `model`. Measured on the real chat, "done"
 *    evidence is rare (3 of 87 tasks), so inference both misses most completions
 *    and would flip tasks silently: it is recorded as a hint only. `model` only
 *    ever CREATES a task (as 'suggested').
 *  - 'suggested' is a creation state, never a transition target: once a person
 *    has confirmed or closed a task, nothing turns it back into a guess.
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

/** D4 layer of each source. 0 never applies. */
const LAYER: Readonly<Record<EventSource, number>> = {
  manual: 3,
  tag: 2,
  reply: 2,
  react: 2,
  poll: 2,
  inferred: 0,
  model: 0,
};

/**
 * Should an event move a task to `next`? `current` is the task's status and
 * the source that set it.
 */
export function shouldApply(
  current: { status: TaskStatus; source: EventSource },
  next: TaskStatus,
  source: EventSource,
): boolean {
  if (LAYER[source] === 0) return false;
  if (next === "suggested") return false;
  if (LAYER[source] < LAYER[current.source]) return false;
  if (current.status === next) return LAYER[source] > LAYER[current.source];
  return true;
}

export function isTaskStatus(v: string): v is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v);
}
