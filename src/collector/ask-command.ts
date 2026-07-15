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
  /** Per-group in-flight lock so two @Aida questions don't run Ollama concurrently. */
  inFlight: Set<number>;
  /** Canonicalize a 1:1 @lid to its phone JID (groups @g.us pass through). */
  resolvePn?: (lid: string) => Promise<string | null>;
  /**
   * Answer the question for the ALREADY-verified group id, grounded in that
   * group's messages. Wired to answerQuestion in prod; tests inject a fake.
   */
  answer: (input: { groupId: number; question: string }) => Promise<string>;
  log?: MinimalLog;
};

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
  // Cheap pre-gate: no "@" → ordinary chatter never touches the DB or the regex.
  if (!text.includes("@")) return false;

  const match = matchAskTrigger(text);
  if (!match || match.question.length === 0) return false; // bare "@Aida" → nothing to answer

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

    if (deps.inFlight.has(groupId)) {
      deps.log?.info({ groupId }, "@Aida: already answering, skipping");
      return false;
    }
    deps.inFlight.add(groupId);
    acquired = true;

    await react("⏳");
    // groupId is the VERIFIED inbound id — the privacy boundary for retrieval.
    const answer = await deps.answer({ groupId, question: match.question });
    await deps.sendText(jid, answer, { quoted: msg });
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
