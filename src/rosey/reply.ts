/**
 * reply.ts — Rosey's ONE send: the current list, as a reply to a member's
 * "@Rosey מה המשימות?" in the group. This is the only file of hers that may
 * name a send primitive (isolation.test.ts holds her to it).
 *
 * Her own gate, separate from @Aida's and checked on every reply. It runs even
 * when WHATSAPP_ALLOW_SEND=true turns the shared outbound guard into a no-op;
 * when the guard is on, a reply must clear both. In order, each failing closed:
 *  1. ROSEY_SEND_MODE: `off` (the default, and the kill switch) sends nothing;
 *     `dry-run` logs the exact text it would send and sends nothing; only
 *     `live` sends;
 *  2. a group chat (…@g.us), never a 1:1;
 *  3. the group is on Rosey's OWN allowlist key ('rosey'), re-read now — a
 *     failed read blocks the reply;
 *  4. her rate limits (LIST_REPLY_LIMITS), counted from rosey_messages so a
 *     restart does not reset them; a reply over a limit is dropped, never queued;
 *  5. the text carries no "@" at all, so it can wake neither @Aida nor Rosey.
 * The caller decides that a message IS a live list request from a member (see
 * capture.ts); this file decides whether a reply may leave.
 *
 * Every real send is recorded in rosey_messages, which is also her own-echo
 * guard — and recorded BEFORE it leaves, under a message id chosen here and
 * handed to WhatsApp, so there is no moment when her own post could come back
 * unrecognised (and be read as chatter for the suggestion pass). A record that
 * fails sends nothing. A send that fails or times out keeps its record: it may
 * have reached WhatsApp anyway, so its echo must stay hers, and it counts
 * toward the limits. A dry run is not recorded and does not count: nothing was
 * sent.
 *
 * The send is bounded (sendTimeoutMs): a hung socket returns `timed_out` and
 * releases the chat, instead of holding every later message in it.
 *
 * Her sends reach the shared outbound guard inside her own send scope
 * (roseySender), so her allowlist admits her groups to HER sends only — never
 * to @Aida's or a /סיכום post.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import { matchAskTrigger } from "../collector/ask-trigger.js";
import { withSendScope } from "../collector/outbound-guard.js";
import type { RoseyTask } from "../db/repositories/rosey-tasks.js";

// ── Mode and limits ───────────────────────────────────────────────────────────

export type RoseySendMode = "off" | "dry-run" | "live";

/** ROSEY_SEND_MODE: anything but exactly "dry-run" or "live" is off. */
export function parseSendMode(raw: string | undefined): RoseySendMode {
  return raw === "dry-run" || raw === "live" ? raw : "off";
}

/** The outbound guard's scope for Rosey's sends (its `scoped` allowlist key). */
export const ROSEY_SEND_SCOPE = "rosey";

/** How long one list-reply send may take before the chat is released. */
export const SEND_TIMEOUT_MS = 20_000;

const HOUR = 3_600_000;

/** Per group, list replies: at most 6 an hour and 20 a day (docs/PLAN-task-bot §4). */
export const LIST_REPLY_LIMITS: readonly { windowMs: number; max: number }[] = [
  { windowMs: HOUR, max: 6 },
  { windowMs: 24 * HOUR, max: 20 },
];

/** "Done this week": done within the last 7 days. */
export const DONE_WINDOW_MS = 7 * 24 * HOUR;

// ── The reply text ────────────────────────────────────────────────────────────

/**
 * WhatsApp takes up to 65,536 characters in one message, but a list past a few
 * screens is not read. The reply stays well inside both.
 */
export const MAX_REPLY_CHARS = 4000;
/** Items shown per status group; the rest are counted, not listed. */
export const MAX_ITEMS_PER_GROUP = 30;

export type ListSnapshot = {
  /** Suggested and open items, both kinds. */
  live: RoseyTask[];
  /** Items done within DONE_WINDOW_MS, both kinds. */
  doneRecently: RoseyTask[];
};

/** A title as one line with no "@": neither bot's tag can survive it. */
function cleanTitle(title: string): string {
  return title.replace(/[@＠]/g, "").replace(/\s+/g, " ").trim();
}

const byRaised = (a: RoseyTask, b: RoseyTask) =>
  a.raisedAt.getTime() - b.raisedAt.getTime() || a.id - b.id;

function itemLines(mark: string, items: RoseyTask[]): string[] {
  const shown = items.slice(0, MAX_ITEMS_PER_GROUP).map((t) => `${mark} ${cleanTitle(t.title)}`);
  const rest = items.length - shown.length;
  return rest > 0 ? [...shown, `…ועוד ${rest}`] : shown;
}

function section(heading: string, live: RoseyTask[], done: RoseyTask[]): string[] {
  const open = live.filter((t) => t.status === "open").sort(byRaised);
  const suggested = live.filter((t) => t.status === "suggested").sort(byRaised);
  if (open.length + suggested.length + done.length === 0) return [];
  const out = ["", heading, ...itemLines("✅", [...done].sort(byRaised))];
  out.push(...itemLines("⬜", open));
  if (suggested.length > 0) {
    out.push(`💭 הצעות שעוד לא אושרו (${suggested.length})`, ...itemLines("⬜", suggested));
  }
  return out;
}

/**
 * The list as Rosey posts it: signed, tasks first, then a separate 🛒 grocery
 * section. In each: ✅ done this week, ⬜ not done, then the model's
 * suggestions nobody confirmed yet, under their own 💭 heading — shown, not
 * hidden, because most of a list starts as suggestions, and marked, because a
 * guess must never read as something a member asked for.
 */
export function renderListReply(s: ListSnapshot): string {
  const head = "🤖 רוזי";
  const all = [...s.live, ...s.doneRecently];
  if (all.length === 0) return `${head}\n📋 הרשימה ריקה.`;
  const open = s.live.filter((t) => t.status === "open").length;
  const suggested = s.live.filter((t) => t.status === "suggested").length;
  const counts = [`${s.doneRecently.length} בוצעו בשבוע האחרון`, `${open} פתוחות`];
  if (suggested > 0) counts.push(`${suggested} הצעות`);
  const of = (kind: RoseyTask["kind"]) => (t: RoseyTask) => t.kind === kind;
  const lines = [
    head,
    `📋 הרשימה · ${counts.join(" · ")}`,
    ...section("משימות", s.live.filter(of("task")), s.doneRecently.filter(of("task"))),
    ...section("🛒 קניות", s.live.filter(of("grocery")), s.doneRecently.filter(of("grocery"))),
  ];
  return fitLength(lines);
}

/** Whole lines up to MAX_REPLY_CHARS, then a count of the item lines left out. */
function fitLength(lines: string[]): string {
  const full = lines.join("\n");
  if (full.length <= MAX_REPLY_CHARS) return full;
  const tailRoom = 40;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > MAX_REPLY_CHARS - tailRoom) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.slice(kept.length).filter((l) => /^[✅⬜]/u.test(l)).length;
  return [...kept, `…ועוד ${dropped}`].join("\n");
}

// ── The gate ──────────────────────────────────────────────────────────────────

/** The one send Rosey is handed: a text reply quoting the request, under a chosen id. */
export type RoseySender = {
  sendText: (
    jid: string,
    text: string,
    opts: { quoted?: WAMessage; messageId?: string },
  ) => Promise<WAMessage | undefined>;
};

/**
 * The collector session as Rosey's sender: every send runs inside her send
 * scope, which is the only way the outbound guard admits her own groups.
 */
export function roseySender(session: RoseySender): RoseySender {
  return {
    sendText: (jid, text, opts) =>
      withSendScope(ROSEY_SEND_SCOPE, () => session.sendText(jid, text, opts)),
  };
}

type Log = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type ListReplyDeps = {
  mode: RoseySendMode;
  /** Group JIDs on Rosey's allowlist ('rosey'), read now. Throwing blocks the reply. */
  resolveEnabledJids: () => Promise<ReadonlySet<string>>;
  /** Her list replies to this group at or after `since` (rosey_messages). */
  countRepliesSince: (groupId: number, since: Date) => Promise<number>;
  loadList: (groupId: number, now: Date) => Promise<ListSnapshot>;
  /** Record a reply of hers (rosey_messages, kind 'reply'). Called BEFORE the send. */
  record: (groupId: number, externalId: string) => Promise<void>;
  /** Re-key the record to the id WhatsApp reported, when it differs from the chosen one. */
  reconcile: (groupId: number, chosenId: string, reportedId: string) => Promise<void>;
  /** A fresh WhatsApp message id for the reply, known before it is sent. */
  newMessageId: () => string;
  /** Bound on one send; defaults to SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
  /** Absent when the collector handed her no session: nothing can be sent. */
  sender: RoseySender | undefined;
  now: () => number;
  log?: Log;
  /** Injectable for tests; defaults to renderListReply. */
  render?: (s: ListSnapshot) => string;
};

export type ListReplySkip =
  | "off"
  | "not_a_group"
  | "allowlist_error"
  | "not_enabled"
  | "rate_limited"
  | "unsafe_text"
  | "no_sender";

export type ListReplyOutcome =
  | { kind: "skipped"; reason: ListReplySkip }
  | { kind: "dry_run"; chars: number }
  | { kind: "sent"; externalId: string }
  | { kind: "failed" }
  | { kind: "timed_out" };

/**
 * Reply to one list request, if the gate allows it. Run it inside the group's
 * serial queue: the rate-limit count and the record must not interleave with
 * another reply to the same group.
 */
export async function replyWithList(
  deps: ListReplyDeps,
  req: { jid: string; groupId: number; quoted: WAMessage },
): Promise<ListReplyOutcome> {
  const skip = (reason: ListReplySkip): ListReplyOutcome => {
    deps.log?.info({ groupId: req.groupId, reason }, "rosey: list reply not sent");
    return { kind: "skipped", reason };
  };
  if (deps.mode === "off") return skip("off");
  if (!req.jid.endsWith("@g.us")) return skip("not_a_group");

  let enabled: ReadonlySet<string>;
  try {
    enabled = await deps.resolveEnabledJids();
  } catch (err) {
    deps.log?.warn({ err, groupId: req.groupId }, "rosey: allowlist read failed; reply blocked");
    return skip("allowlist_error");
  }
  if (!enabled.has(req.jid)) return skip("not_enabled");

  const now = deps.now();
  for (const limit of LIST_REPLY_LIMITS) {
    const sent = await deps.countRepliesSince(req.groupId, new Date(now - limit.windowMs));
    if (sent >= limit.max) return skip("rate_limited");
  }

  const text = (deps.render ?? renderListReply)(await deps.loadList(req.groupId, new Date(now)));
  if (/[@＠]/.test(text) || matchAskTrigger(text)) return skip("unsafe_text");

  if (deps.mode === "dry-run") {
    // The exact text, on purpose: dry-run exists to read it before going live.
    // It stays in the local log, like the chat it came from.
    deps.log?.info({ groupId: req.groupId, text }, "rosey: dry-run list reply (not sent)");
    return { kind: "dry_run", chars: text.length };
  }
  if (!deps.sender) return skip("no_sender");

  // Recorded first: her echo can arrive before the send resolves.
  const messageId = deps.newMessageId();
  try {
    await deps.record(req.groupId, messageId);
  } catch (err) {
    deps.log?.error({ err, groupId: req.groupId }, "rosey: list reply not recorded; not sent");
    return { kind: "failed" };
  }

  const send = deps.sender.sendText(req.jid, text, { quoted: req.quoted, messageId });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS);
  });
  let sent: WAMessage | undefined | "timed_out";
  try {
    sent = await Promise.race([send, timedOut]);
  } catch (err) {
    deps.log?.error({ err, groupId: req.groupId, messageId }, "rosey: list reply failed to send");
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
  if (sent === "timed_out") {
    // The send may still complete; its record stays so the echo is hers. A late
    // rejection is logged here, never left unhandled.
    send.catch((err: unknown) =>
      deps.log?.error({ err, groupId: req.groupId, messageId }, "rosey: timed-out send failed"),
    );
    deps.log?.error({ groupId: req.groupId, messageId }, "rosey: list reply send timed out");
    return { kind: "timed_out" };
  }

  const externalId = sent?.key?.id ?? messageId;
  if (externalId !== messageId) {
    // WhatsApp keyed it differently from the id we chose (Baileys normally
    // keeps it): re-key her record so the echo still matches.
    await deps
      .reconcile(req.groupId, messageId, externalId)
      .catch((err: unknown) =>
        deps.log?.error(
          { err, groupId: req.groupId, externalId },
          "rosey: list reply's reported id not reconciled",
        ),
      );
  }
  deps.log?.info({ groupId: req.groupId, chars: text.length }, "rosey: list reply sent");
  return { kind: "sent", externalId };
}
