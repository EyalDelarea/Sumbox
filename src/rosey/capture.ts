/**
 * capture.ts — Rosey's live path: one incoming WhatsApp message in, at most a
 * store write out. RECEIVE ONLY — this path has no way to send anything.
 *
 * Runs as a sibling of ingest, /סיכום and @Aida in the collector, AFTER the
 * message has been ingested (a task must cite the stored message row).
 *
 * Gates, in order, each failing closed:
 *  1. a group chat (…@g.us) — Rosey never acts in a 1:1;
 *  2. the group is on Rosey's OWN allowlist key ('rosey'), read live per message
 *     (being on the /סיכום or @Aida list does not count);
 *  3. not one of Rosey's own posts (rosey_messages) — no loops, ever;
 *  4. live: sent within the last 120 s, so a reconnect replay never acts;
 *  5. not addressed to @Aida: a message that wakes her (her tag, anywhere) is
 *     hers alone, so "@Aida what did @Rosey add?" is answered once, by her;
 *  6. not one of @Aida's posts (aida_messages). Her posts come from the owner's
 *     account (from_me), and her marker is written only after her send
 *     resolves — her echo can reach us first. So a from_me command waits a
 *     short grace before the marker is read. A member's message is never hers,
 *     and never waits.
 * Then a tagged message is applied as an explicit command; an untagged one only
 * schedules the group's debounced suggestion pass.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
// @Aida's own trigger matcher, read as-is: a pure module with no imports, so
// using it does not reach src/ask (isolation.test.ts walks the graph to prove it).
import { matchAskTrigger } from "../collector/ask-trigger.js";
import { mapWaMessage } from "../collector/message-mapper.js";
import type { CommandOutcome } from "./commands.js";
import type { RoseyCommand, TagMatcher } from "./tags.js";

/** Same liveness horizon as @Aida and /סיכום: older is a replay. */
export const LIVENESS_WINDOW_MS = 120_000;

export type CaptureDeps = {
  matcher: TagMatcher;
  /** Group JIDs enabled for Rosey ('rosey' key). Throwing fails closed. */
  resolveEnabledJids: () => Promise<ReadonlySet<string>>;
  groupIdForJid: (jid: string) => Promise<number | null>;
  messageIdFor: (groupId: number, externalId: string) => Promise<number | null>;
  isOwnPost: (groupId: number, externalId: string) => Promise<boolean>;
  /** Did @Aida send this message (her replies and summary posts)? */
  isAidaPost: (groupId: number, externalId: string) => Promise<boolean>;
  /** Wait long enough for @Aida's marker to follow her echo (from_me commands only). */
  ownEchoGrace: () => Promise<void>;
  /**
   * The live path takes this command: from here on it decides it, so the
   * catch-up must not replay it (see run.ts) — unless its apply throws.
   */
  claimCommand: (messageId: number) => void;
  applyCommand: (
    cmd: RoseyCommand,
    ctx: { groupId: number; messageId: number; sentAt: Date; quotedMessageId: number | null },
  ) => Promise<CommandOutcome>;
  scheduleSuggestions: (groupId: number) => void;
  log?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
  /** When the message ARRIVED (not when this runs): the liveness rule's clock. */
  now?: () => number;
};

export type CaptureResult =
  | { kind: "ignored"; reason: string }
  | { kind: "scheduled"; groupId: number }
  | { kind: "command"; groupId: number; outcome: CommandOutcome };

/** The stanza id of the message this one quotes, if it is a reply. */
function quotedStanzaId(msg: WAMessage): string | null {
  const m = msg.message;
  const ctx =
    m?.extendedTextMessage?.contextInfo ??
    m?.imageMessage?.contextInfo ??
    m?.videoMessage?.contextInfo ??
    m?.audioMessage?.contextInfo ??
    m?.documentMessage?.contextInfo;
  return ctx?.stanzaId ?? null;
}

export async function captureMessage(msg: WAMessage, deps: CaptureDeps): Promise<CaptureResult> {
  const now = deps.now ?? Date.now;
  const mapped = mapWaMessage(msg);
  if (!mapped) return { kind: "ignored", reason: "unmappable" };
  if (!mapped.remoteJid.endsWith("@g.us")) return { kind: "ignored", reason: "not_a_group" };

  let enabled: ReadonlySet<string>;
  try {
    enabled = await deps.resolveEnabledJids();
  } catch (err) {
    deps.log?.warn({ err }, "rosey: allowlist lookup failed; ignoring (fail closed)");
    return { kind: "ignored", reason: "allowlist_error" };
  }
  if (!enabled.has(mapped.remoteJid)) return { kind: "ignored", reason: "not_enabled" };

  const groupId = await deps.groupIdForJid(mapped.remoteJid);
  if (groupId === null) {
    deps.log?.warn({}, "rosey: enabled group has no group row; message ignored");
    return { kind: "ignored", reason: "unknown_group" };
  }
  if (await deps.isOwnPost(groupId, mapped.externalId)) {
    return { kind: "ignored", reason: "own_post" };
  }
  if (now() - mapped.sentAt.getTime() > LIVENESS_WINDOW_MS) {
    // A replay. Never applied here — but it schedules a pass, and that pass's
    // catch-up applies a late command (see run.ts), even if the group then goes
    // quiet.
    deps.scheduleSuggestions(groupId);
    return { kind: "ignored", reason: "stale" };
  }

  const text = (mapped.textContent ?? "").trim();
  if (matchAskTrigger(text)) return { kind: "ignored", reason: "aida_trigger" };

  const cmd = deps.matcher.parse(text);
  if (!cmd) {
    // A bare "@Rosey" with nothing to do is still not chatter for the model.
    if (deps.matcher.isTagged(mapped.textContent ?? "")) {
      return { kind: "ignored", reason: "empty_tag" };
    }
    deps.scheduleSuggestions(groupId);
    return { kind: "scheduled", groupId };
  }

  if (mapped.fromMe) {
    await deps.ownEchoGrace();
    if (await deps.isAidaPost(groupId, mapped.externalId)) {
      return { kind: "ignored", reason: "aida_post" };
    }
  }

  const messageId = await deps.messageIdFor(groupId, mapped.externalId);
  if (messageId === null) {
    // Ingest runs first; a miss means it failed or skipped this message. A task
    // must cite a stored message, so there is nothing to write.
    deps.log?.warn({ groupId }, "rosey: tagged message was not ingested; command not applied");
    return { kind: "ignored", reason: "not_ingested" };
  }
  deps.claimCommand(messageId);
  const quoted = quotedStanzaId(msg);
  const quotedMessageId = quoted ? await deps.messageIdFor(groupId, quoted) : null;
  if (quoted && quotedMessageId === null) {
    // The quote is the command's scope. Matching without it could close a task
    // the sender never pointed at, so an unresolvable quote applies nothing.
    deps.log?.warn({ groupId, messageId }, "rosey: quoted message not stored; command not applied");
    return { kind: "ignored", reason: "quote_not_ingested" };
  }
  const outcome = await deps.applyCommand(cmd, {
    groupId,
    messageId,
    sentAt: mapped.sentAt,
    quotedMessageId,
  });
  // Ids and counts only — a log line never carries chat text.
  deps.log?.info({ groupId, messageId, outcome }, "rosey: command applied");
  return { kind: "command", groupId, outcome };
}
