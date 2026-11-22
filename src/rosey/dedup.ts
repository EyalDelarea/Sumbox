/**
 * dedup.ts — is a new candidate the same task as one already on the list?
 *
 * INCREMENTAL by design: one new candidate against the current live tasks, one
 * small question at a time. Measured on the real chat, asking the model to
 * merge a whole list in one pass was unstable — one run silently dropped every
 * task after the first 10-20, and a batched re-run over-merged. A per-candidate
 * question has a closed answer space (a number from the list, or null) that can
 * be validated completely.
 *
 * A bad answer never loses a candidate: an unparseable or out-of-range answer
 * means "not a duplicate" and the candidate is kept (and counted, so a degrading
 * model shows up in the run report instead of as silently doubled tasks).
 */

import { lastJsonValue } from "./text.js";

export type LiveTaskRef = { id: number; title: string; titleKey: string };

export type DedupDecision =
  | { kind: "exact"; taskId: number }
  | { kind: "model"; taskId: number }
  | { kind: "new" }
  /** The model's answer could not be validated; kept as new. */
  | { kind: "new_unparsed" };

export const DEDUP_SYSTEM =
  "You compare to-do items from a family chat. You reply with JSON only, never prose.";

export function buildDedupPrompt(title: string, live: readonly LiveTaskRef[]): string {
  return [
    "Existing open items:",
    ...live.map((t, i) => `${i + 1}. ${t.title}`),
    "",
    `New item: ${title}`,
    "",
    "Is the new item the SAME thing to do as one of the existing items (the same product to buy, the same call to make)? Related is not the same: 'לקנות חלב' and 'לקנות ביצים' are different.",
    'Reply with exactly {"same_as": <the existing item number>} or {"same_as": null}.',
  ].join("\n");
}

/** Validate the model's answer: an in-range number → that task; null → new. */
export function parseDedupAnswer(
  reply: string,
  live: readonly LiveTaskRef[],
): DedupDecision | null {
  const json = lastJsonValue(reply);
  if (!json || typeof json !== "object" || !("same_as" in json)) return null;
  const v = (json as { same_as: unknown }).same_as;
  if (v === null) return { kind: "new" };
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > live.length) return null;
  return { kind: "model", taskId: live[n - 1]!.id };
}

export async function decideDuplicate(
  candidate: { title: string; titleKey: string },
  live: readonly LiveTaskRef[],
  generate: (system: string, user: string) => Promise<string>,
): Promise<DedupDecision> {
  const exact = live.find((t) => t.titleKey === candidate.titleKey);
  if (exact) return { kind: "exact", taskId: exact.id };
  if (live.length === 0) return { kind: "new" };
  // A transport failure (Ollama down) THROWS to the caller: it is not an answer,
  // and turning it into "new" would quietly double every task during an outage.
  const reply = await generate(DEDUP_SYSTEM, buildDedupPrompt(candidate.title, live));
  return parseDedupAnswer(reply, live) ?? { kind: "new_unparsed" };
}
