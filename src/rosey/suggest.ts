/**
 * suggest.ts — model-suggested tasks from a batch of chat messages (D3: the
 * model only ever SUGGESTS; an explicit @Rosey tag is the firm path).
 *
 * Two lessons from measuring task extraction on the real chat are built in:
 *
 *  1. The main false-positive class is past events and one-off plans read as
 *     tasks. That filter is STRUCTURAL, not a "please don't" sentence: the model
 *     must label every candidate with a `kind`, and only `kind: "task"` and
 *     `kind: "grocery"` are kept. A declared label is checkable; an omission is
 *     not. (A prompt rule's position matters more than its wording, so it is
 *     also rule 1.)
 *  1b. Most of what the chat holds is a shopping list. A product to buy
 *     ("milk") is labelled `grocery` and stored apart from real tasks; an
 *     errand that involves buying ("a gift for X", "order a plumber") stays a
 *     task. That rule is RULE 2, directly under rule 1, for the same reason.
 *  2. One message is often a list. The model emits one object per item; the
 *     item's position within its message is only a preferred slot — the store
 *     keys an item on its message and normalized title, because the model does
 *     not number the same message's items the same way on every run.
 *
 * Every candidate must cite a message id from THIS batch. On an earlier probe
 * of the same model, 40% of citations were invented; an id outside the batch is
 * rejected, never trusted.
 */

import type { RoseySourceMessage } from "../db/repositories/rosey-tasks.js";
import { resolveSenderName } from "../summarization/sender-name.js";
import type { RoseyItemKind } from "./kind.js";
import { MAX_TITLE_CHARS } from "./tags.js";
import { lastJsonValue, salvageItemObjects } from "./text.js";

/** Characters of one message shown to the model; a long message is still read, only trimmed. */
const MAX_MESSAGE_CHARS = 600;

export const SUGGEST_KINDS = ["task", "grocery", "past", "plan", "other"] as const;
type SuggestKind = (typeof SUGGEST_KINDS)[number];
/** The labels that are kept, each as the item kind it is stored under. */
type KeptKind = SuggestKind & RoseyItemKind;
const isKept = (k: SuggestKind): k is KeptKind => k === "task" || k === "grocery";

export type SuggestedItem = {
  sourceMessageId: number;
  /** Position among the kept items of its message, from 0: a preferred slot, not an identity. */
  itemIndex: number;
  title: string;
  kind: RoseyItemKind;
};

export type RejectReason =
  | "not_an_object"
  | "unknown_message_id"
  | "bad_kind"
  | "empty_text"
  /** Not valid JSON on its own (a garbled id); its siblings are still read. */
  | "malformed_object";

export type ParsedSuggestions = {
  items: SuggestedItem[];
  /** Candidates thrown out as malformed or uncited, by reason. */
  rejected: Partial<Record<RejectReason, number>>;
  /** Well-formed candidates the model itself labelled as not-a-task, by label. */
  droppedByKind: Partial<Record<Exclude<SuggestKind, KeptKind>, number>>;
};

export const SUGGEST_SYSTEM =
  "You find to-do items in a family WhatsApp chat written in Hebrew. You reply with JSON only, never prose.";

/** One message as the model sees it: `[id] date sender: text`, on one line. */
function renderLine(m: RoseySourceMessage): string {
  const date = m.sentAt.toISOString().slice(0, 10);
  const text = m.content.replace(/\s*\n\s*/g, " / ").slice(0, MAX_MESSAGE_CHARS);
  const voice = m.isVoice ? " (voice note)" : "";
  return `[${m.messageId}] ${date} ${resolveSenderName(m.sender)}${voice}: ${text}`;
}

export function buildSuggestPrompt(batch: readonly RoseySourceMessage[]): string {
  return [
    'RULE 1. A "task" is a FUTURE action someone in the chat still has to do: call, book, pay, fix, send, check, bring, arrange. Something that already happened, a report that something was done, a social plan or meeting, a question, an opinion or a feeling is NOT a task. Label it as such — do not leave it out.',
    'RULE 2. A product still to be bought for the home — food, drinks, household consumables (milk, bread, eggs, toilet paper, dish soap) — is "grocery", not "task": one object per product, its text the product alone ("חלב", not "to buy milk"). Errands, chores, appointments and services stay "task", even when they mean buying or ordering: "לקנות מתנה לדני", "להזמין אינסטלטור". A product already bought is "past".',
    "",
    "For every candidate output one object:",
    '  "m":    the number in [brackets] of the message it comes from — only numbers that appear below',
    '  "kind": "task" | "grocery" (a product for the shopping list) | "past" (already happened or done) | "plan" (an event, meeting or outing) | "other"',
    '  "text": the item in short Hebrew, at most 12 words, e.g. "להתקשר לרופא" — for grocery, the product, e.g. "חלב"',
    "A message can hold several items (a shopping list): one object per item, in the order they appear.",
    "",
    'Reply with exactly: {"items": [ ... ]}   — or {"items": []} when there is nothing.',
    "",
    "Messages:",
    ...batch.map(renderLine),
  ].join("\n");
}

const isObject = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A bare array of candidate OBJECTS, or `{"items": [...]}`. A bare array of
 * anything else is prose ("message [12]"), not an answer, and must not beat
 * the real one.
 */
const isSuggestionList = (v: unknown): boolean =>
  (Array.isArray(v) && v.every(isObject)) ||
  (isObject(v) && Array.isArray((v as { items?: unknown }).items));

/** `{"items": [...]}` with at least one entry: an answer that said something. */
const isNonEmptyItems = (v: unknown): boolean =>
  isObject(v) &&
  Array.isArray((v as { items?: unknown }).items) &&
  (v as { items: unknown[] }).items.length > 0;

export function parseSuggestions(
  reply: string,
  batch: readonly RoseySourceMessage[],
): ParsedSuggestions | null {
  const json = lastJsonValue(reply, isSuggestionList);
  let list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { items?: unknown }).items)
      ? (json as { items: unknown[] }).items
      : null;
  let malformed = 0;
  if (!list) {
    // No valid answer as a whole: read its items array object by object. A
    // truncated reply, or one with nothing whole in it, is still a failure.
    const salvaged = salvageItemObjects(reply);
    if (!salvaged || salvaged.objects.length === 0) return null;
    list = salvaged.objects;
    malformed = salvaged.malformed;
  }

  const ids = new Set(batch.map((m) => m.messageId));
  const nextIndex = new Map<number, number>();
  const out: ParsedSuggestions = { items: [], rejected: {}, droppedByKind: {} };
  const reject = (r: RejectReason) => {
    out.rejected[r] = (out.rejected[r] ?? 0) + 1;
  };
  if (malformed > 0) out.rejected.malformed_object = malformed;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      reject("not_an_object");
      continue;
    }
    const o = raw as { m?: unknown; kind?: unknown; text?: unknown };
    const id = typeof o.m === "number" ? o.m : typeof o.m === "string" ? Number(o.m) : Number.NaN;
    if (!ids.has(id)) {
      reject("unknown_message_id");
      continue;
    }
    if (typeof o.kind !== "string" || !(SUGGEST_KINDS as readonly string[]).includes(o.kind)) {
      reject("bad_kind");
      continue;
    }
    const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim() : "";
    if (!text) {
      reject("empty_text");
      continue;
    }
    const kind = o.kind as SuggestKind;
    if (!isKept(kind)) {
      out.droppedByKind[kind] = (out.droppedByKind[kind] ?? 0) + 1;
      continue;
    }
    const itemIndex = nextIndex.get(id) ?? 0;
    nextIndex.set(id, itemIndex + 1);
    out.items.push({
      sourceMessageId: id,
      itemIndex,
      title: text.slice(0, MAX_TITLE_CHARS),
      kind,
    });
  }
  // Nothing parseable (no task, no labelled non-task) from a value that is not
  // itself the items answer (a bare array, or an empty list), while the reply
  // holds a non-empty items answer elsewhere: what was read was not the answer.
  // A failure, so the batch is retried, never "zero tasks", which would let the
  // cursor skip it. An items answer whose entries are all malformed stays a
  // result: its rejections are counted.
  const parsed = out.items.length + Object.values(out.droppedByKind).reduce((a, b) => a + b, 0);
  const notTheAnswer = Array.isArray(json) || list.length === 0;
  if (parsed === 0 && notTheAnswer && lastJsonValue(reply, isNonEmptyItems) !== null) return null;
  return out;
}
