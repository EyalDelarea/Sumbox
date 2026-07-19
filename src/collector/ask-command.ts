/**
 * ask-command.ts — the in-group @Aida (@אידה) Q&A reply.
 *
 * Sibling of summary-command.ts and bound by the SAME leak contract: it is an
 * allowlisted exception to the passive-observer rule, sends only into a group
 * enabled in group_command_permissions (resolved live per message), and answers
 * strictly from that VERIFIED group's own messages — no name lookup, so it can't
 * cross chats. All inference (bge-m3 embed + gemma answer) is local; nothing
 * leaves the device.
 *
 * Scoping/liveness/in-flight mirror summary-command.ts exactly, on purpose: the
 * two features share one privacy and safety model.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import type { CitedAnswer } from "../ask/citations.js";
import { isAidaMessage, recordAidaMessage } from "../db/repositories/aida-messages.js";
import { resolveCitationSource } from "../db/repositories/citation-sources.js";
import { matchAskTrigger } from "./ask-trigger.js";
import { mapWaMessage } from "./message-mapper.js";

type MinimalLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type AskCommandDeps = {
  pool: pg.Pool;
  /** Group JIDs where @Aida is active — the SAME allowlist as /סיכום. */
  resolveEnabledJids: () => Promise<ReadonlySet<string>>;
  /** Sends the answer back into the group. */
  sendText: (
    jid: string,
    text: string,
    opts?: { quoted?: WAMessage },
  ) => Promise<WAMessage | undefined>;
  /** Optional ⏳/✅/❌ reactions on the asking message. Best-effort. */
  react?: (jid: string, key: WAMessage["key"], emoji: string) => Promise<void>;
  /**
   * Reconstruct a quotable message from a stored id + text + author
   * (CollectorSession.quotedFrom). Absent → she always quotes the asker, which
   * is exactly the pre-citation behaviour.
   */
  makeQuoted?: (
    jid: string,
    waMessageId: string,
    text: string,
    author?: { jid?: string | null; fromMe?: boolean },
  ) => WAMessage;
  /** Per-group in-flight lock so two @Aida questions don't run Ollama concurrently. */
  inFlight: Set<number>;
  /** Canonicalize a 1:1 @lid to its phone JID (groups @g.us pass through). */
  resolvePn?: (lid: string) => Promise<string | null>;
  /**
   * Answer the question for the ALREADY-verified group id, grounded in that
   * group's messages. Wired to answerQuestion in prod; tests inject a fake.
   *
   * Returns the send-ready text plus the message ids the answer rests on — the
   * citations are already stripped from `text`, so this layer never has to know
   * the tag format.
   */
  answer: (input: {
    groupId: number;
    question: string;
    /** The asker's display name — lets her resolve "מה אמרתי?" to a person. */
    askerName?: string;
  }) => Promise<CitedAnswer>;
  log?: MinimalLog;
};

/**
 * The id of the message this one quotes, if any.
 *
 * Baileys hangs contextInfo off whichever message variant carries it; a text
 * reply is extendedTextMessage, but a reply with an image/video/etc. carries its
 * own. Checking only the text variant would silently drop reply-threads on any
 * media reply.
 */
function quotedStanzaId(msg: WAMessage): string | null {
  const m = msg.message;
  const ctx =
    m?.extendedTextMessage?.contextInfo ??
    m?.imageMessage?.contextInfo ??
    m?.videoMessage?.contextInfo ??
    m?.audioMessage?.contextInfo ??
    m?.documentMessage?.contextInfo ??
    m?.stickerMessage?.contextInfo;
  return ctx?.stanzaId ?? null;
}

/**
 * The message to quote-reply, or null to quote the asker as usual.
 *
 * ONE citation → the answer rests on one message, so pin to it: "איפה אמרנו X?"
 * lands on the real thing, and an over-claimed source becomes visible instead of
 * hiding behind a confident sentence.
 *
 * ZERO or MANY → quote the asker. Many means she synthesised across messages
 * ("על מה דיברנו השבוע?") and no single one is THE source; pinning an arbitrary
 * pick would assert a precision she didn't have.
 *
 * This replaces an intent classifier that was built and measured first. Both a
 * verb regex (precision 0.67 / recall 0.25) and gemma4 (1.00/0.38 narrow;
 * 0.63/0.63 broad, flipping on 4 of 25 identical runs) failed on real questions,
 * because "locate question" is not a real category — almost every question she
 * answers has a source message. The citation count reads the grounding she
 * actually produced instead of predicting what she'll want, and costs nothing.
 *
 * Best-effort throughout: any failure returns null and she quotes the asker. A
 * citation must never cost the answer.
 */
async function resolveQuotedSource(
  deps: AskCommandDeps,
  input: { groupId: number; jid: string; citedIds: number[] },
): Promise<WAMessage | null> {
  const [only] = input.citedIds;
  if (only === undefined || input.citedIds.length !== 1 || !deps.makeQuoted) return null;

  try {
    const src = await resolveCitationSource(deps.pool, { groupId: input.groupId, messageId: only });
    if (!src || src.text.length === 0) return null;
    // Attribution is not optional: without the author's jid Baileys would credit
    // the quote to us, putting someone else's words in the owner's mouth. Only
    // live messages ingested since the collector began recording jids have one;
    // for the rest we drop the pin rather than misattribute.
    if (!src.fromMe && !src.authorJid) {
      deps.log?.info(
        { groupId: input.groupId, messageId: only },
        "@Aida: source has no author jid; not quoting",
      );
      return null;
    }
    return deps.makeQuoted(input.jid, src.externalId, src.text, {
      jid: src.authorJid,
      fromMe: src.fromMe,
    });
  } catch (err) {
    deps.log?.warn({ err, groupId: input.groupId }, "@Aida: failed to resolve cited source");
    return null;
  }
}

/** Ignore replayed/history messages (reconnect batches) — act on live only. */
const LIVENESS_WINDOW_MS = 120_000;
/** Sent when the LLM/retrieval fails, so a failed @Aida isn't a silent no-op. */
const ERROR_REPLY = "סליחה, לא הצלחתי לענות כרגע. נסו שוב עוד רגע.";

/**
 * If `msg` mentions @Aida in an allowlisted group, answer it and reply. Returns
 * true when a reply was sent; false otherwise (not a mention, not allowlisted,
 * already running, stale replay, or an error — all handled quietly so the ingest
 * loop is never disrupted).
 */
export async function maybeHandleAskCommand(
  msg: WAMessage,
  deps: AskCommandDeps,
  now: () => number = Date.now,
): Promise<boolean> {
  const mapped = mapWaMessage(msg);
  if (!mapped) return false;

  const text = (mapped.textContent ?? "").trim();
  const quotedId = quotedStanzaId(msg);
  const match = matchAskTrigger(text);

  // Cheap pre-gate: fire only for an @Aida tag OR a quoted reply. Ordinary
  // chatter still never touches the DB. A reply costs one extra lookup, but only
  // after the group is verified as allowlisted (below) — never for a random chat.
  if (!match && !quotedId) return false;
  // Nothing to answer: a bare "@Aida", or an empty reply body.
  if (text.length === 0) return false;
  if (match && match.question.length === 0 && !quotedId) return false;

  let allowlist: ReadonlySet<string>;
  try {
    allowlist = await deps.resolveEnabledJids();
  } catch (err) {
    // Fail CLOSED: a DB error must never send.
    deps.log?.warn({ err }, "failed to resolve @Aida permissions; ignoring");
    return false;
  }

  // Canonicalize a 1:1 @lid to its phone JID (the allowlist stores that form).
  // A resolver failure here is BEFORE the group is verified as enabled, so fail
  // CLOSED (no reply) rather than act on an unverified chat.
  let jid = mapped.remoteJid;
  if (jid.endsWith("@lid") && deps.resolvePn) {
    try {
      const pn = await deps.resolvePn(jid);
      if (pn) jid = pn;
    } catch (err) {
      deps.log?.warn({ err, jid }, "@Aida: lid resolve failed; fail-closed");
      return false;
    }
  }
  if (!allowlist.has(jid)) return false;

  // Live messages only — never answer a @Aida in a replayed history window.
  if (now() - mapped.sentAt.getTime() > LIVENESS_WINDOW_MS) {
    deps.log?.info({ jid, sentAt: mapped.sentAt }, "@Aida: stale (replay), skipping");
    return false;
  }

  const react = async (emoji: string) => {
    try {
      await deps.react?.(jid, msg.key, emoji);
    } catch {
      /* reactions are cosmetic */
    }
  };

  // From here the message IS a @Aida mention in an enabled group, so EVERY
  // failure must surface (❌ + error reply), never a silent no-op — including a
  // DB error in the group lookup, which previously sat outside the guard and
  // dropped the answer with no feedback. `acquired` tracks whether THIS call took
  // the in-flight lock, so the finally can't release another call's lock.
  let groupId: number | null = null;
  let acquired = false;
  try {
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM groups WHERE whatsapp_id = $1 LIMIT 1`,
      [jid],
    );
    const group = rows[0];
    if (!group) {
      // Not an error — an unknown chat; skip quietly, no ❌.
      deps.log?.warn({ jid }, "@Aida: group not found for JID");
      return false;
    }
    groupId = Number(group.id);

    /**
     * Resolve WHAT she was asked, and whether this message is for her at all.
     *
     * Two ways in:
     *  - an @Aida tag → the question is the text minus the tag;
     *  - a reply quoting a message SHE sent → the whole text is the question,
     *    no tag needed. Swipe-replying to her is an unambiguous act of
     *    addressing her, and requiring "@אידה" on every turn makes a
     *    back-and-forth unusable.
     *
     * The quoted message may be ANY age: thread age and the liveness window are
     * different concerns — liveness exists to ignore replayed history batches on
     * reconnect, not to expire a conversation.
     *
     * Only her OWN messages count. from_me is true for the owner's messages too,
     * so without the marker a reply to Eyal's own message would wake her.
     */
    let question = match?.question ?? "";
    if (!match || question.length === 0) {
      if (!quotedId || !(await isAidaMessage(deps.pool, { groupId, externalId: quotedId }))) {
        return false; // a reply to someone else, or a bare tag — not for her
      }
      question = text;
      deps.log?.info({ groupId }, "@Aida: reply-thread continued");
    }
    if (question.length === 0) return false;

    if (deps.inFlight.has(groupId)) {
      deps.log?.info({ groupId }, "@Aida: already answering, skipping");
      return false;
    }
    deps.inFlight.add(groupId);
    acquired = true;

    await react("⏳");
    // groupId is the VERIFIED inbound id — the privacy boundary for retrieval.
    // askerName lets her resolve first-person questions ("מה אמרתי על אלכס?"):
    // the transcript names every speaker, but nothing else says which of them
    // is the "I" doing the asking — measured live as a false denial on a fact
    // that was in her window.
    const { text: answer, citedIds } = await deps.answer({
      groupId,
      question,
      askerName: mapped.senderName,
    });
    const source = await resolveQuotedSource(deps, { groupId, jid, citedIds });
    const sent = await deps.sendText(jid, answer, { quoted: source ?? msg });
    // Record HER OWN message id, here and now.
    //
    // This is the only moment the system knows a message is hers: WhatsApp echoes
    // it back and the collector ingests it through the same generic path as
    // everyone else's, with no way to tell it apart. Writing at send time (rather
    // than marking the ingested row) is what makes the marker immune to whether —
    // or when — that echo arrives.
    //
    // Best-effort: a failure here costs reply-threading on ONE message and must
    // never turn a delivered answer into a ❌ + error reply.
    const externalId = sent?.key?.id;
    if (externalId) {
      try {
        await recordAidaMessage(deps.pool, {
          groupId,
          externalId,
          question,
        });
      } catch (err) {
        deps.log?.warn({ err, groupId, externalId }, "@Aida: failed to record own message id");
      }
    }
    await react("✅");
    deps.log?.info({ groupId }, "@Aida: replied");
    return true;
  } catch (err) {
    deps.log?.warn({ err, groupId }, "@Aida: failed");
    await react("❌");
    try {
      await deps.sendText(jid, ERROR_REPLY, { quoted: msg });
    } catch {
      /* best-effort */
    }
    return false;
  } finally {
    if (acquired && groupId !== null) deps.inFlight.delete(groupId);
  }
}
