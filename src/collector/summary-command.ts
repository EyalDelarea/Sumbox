/**
 * summary-command.ts — the `/סיכום` in-group command reply.
 *
 * A deliberate, allowlisted exception to the passive-observer rule (see
 * outbound-guard.ts): in a group enabled in group_command_permissions, an
 * inbound message matching the current trigger (both resolved live from the
 * DB per message — see resolveEnabledJids/resolveTrigger) triggers a
 * locally-generated catch-up summary that is sent back into the same group.
 * No message content leaves the device for inference — the summary is
 * Ollama-generated and returns to the same participants.
 *
 * Range = "since this group's last /סיכום". `summary_group_marks` holds one
 * shared cursor per group, advanced only by a successful command — so every
 * asker gets the same window and the conversation is summarized once, not once
 * per participant. (It used to be a cursor per participant, which meant a member
 * who hadn't asked in a week got a week-wide summary minutes after someone else
 * got an hour-wide one.) The cursor deliberately does NOT fall back to
 * `summaries.created_at`: the scheduled digest writes summary rows too, and
 * anchoring on them would let a digest shrink the next manual window. A group
 * with no cursor yet gets a last-N window. The per-user read watermark is
 * intentionally NOT touched, so members' commands never consume the web app's
 * catch-up state.
 *
 * ── Leak contract ───────────────────────────────────────────────────────────
 * This is the only path that sends into a WhatsApp group. A leak = a reply into
 * a chat that is not, right now, an enabled group. Each invariant below has a
 * failable test; keep them green.
 *
 *  1. Kill switch + allowlist semantics — the outbound guard is the last gate:
 *     WHATSAPP_ALLOW_SEND=true → guard is a no-op; =false → every send throws
 *     unless the JID is in the guard's allowlist (the allowlist *permits* a send
 *     in read-only mode). ....... outbound-guard.test.ts ("leaves all methods
 *     untouched", "lets an allowlisted JID call through while others still throw")
 *  2. Deny by default — a command from a group not enabled in the DB never
 *     sends. ........................ summary-command.test.ts ("ignores the
 *     command from an unlisted group")
 *  3. Fail closed — if the per-message DB resolve throws, no send is attempted.
 *     .............................. summary-command.test.ts ("fails CLOSED …")
 *  4. Toggling is immediate, every topology — the enabled set is re-read from
 *     the DB per message by the matcher AND per send by the outbound guard, so
 *     enabling or disabling a group takes effect on the next message, no
 *     restart. ...................... summary-command.test.ts ("toggle-off is
 *     immediate …"), outbound-guard.test.ts ("a JID enabled after the guard was
 *     applied can send …")
 *  5. Verified inbound group id, never a name lookup (#123) — the summary is run
 *     for the resolved inbound groupId, so it can't cross chats/tenants. ........
 *     summary-command.test.ts (run called with `groupId: 7`)
 *  6. Prompt-injection fence (#126) — the transcript is fenced as untrusted and
 *     forged fence markers (in content or sender name) are neutralized. ........
 *     summarization/prompt.test.ts ("fences the transcript …", "neutralizes a
 *     forged fence marker …")
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import type { SummaryGroupMark } from "../db/repositories/summary-group-marks.js";
import { normalizeSummaryOutput } from "../summarization/normalize.js";
import { stripAllMarkers } from "../summarization/parse-structured.js";
import type { RunSummarizeResult } from "../summarization/summarize.js";
import type { SummaryBullet, SummaryOutput } from "../summarization/summarizer.js";
import { mapWaMessage } from "./message-mapper.js";

/** The shipped default trigger. The live value comes from deps.resolveTrigger(). */
export const SUMMARY_COMMAND = "/סיכום";

/**
 * Does this message invoke the summary command?
 *
 * Prefix match, not equality. Equality made `/סיכום <anything>` a SILENT no-op:
 * members typed "/סיכום אוהבים אותך", "/סיכום HELP SOS CALL 911" and similar
 * repeatedly and got nothing back, while the text also landed in the corpus as
 * ordinary conversation (see select.ts, which mirrors this).
 *
 * The trailing text is deliberately IGNORED rather than treated as a topic or
 * focus hint — that would be a new feature, and this is a bug fix. The command
 * fires exactly as if it had been typed bare.
 *
 * The boundary check matters: without it `/סיכוםX` — a different word that
 * merely starts with the trigger — would fire the command.
 */
export function isSummaryTrigger(text: string, trigger: string): boolean {
  if (!text.startsWith(trigger)) return false;
  const rest = text.slice(trigger.length);
  return rest.length === 0 || /^\s/.test(rest);
}

const EMPTY_REPLY = "אין הודעות חדשות מאז הסיכום האחרון.";
/** Sent when generation fails, so a failed command isn't a silent no-op. */
const ERROR_REPLY = "סליחה, לא הצלחתי להכין סיכום כרגע. נסו שוב עוד רגע.";

type MinimalLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type SummaryCommandDeps = {
  pool: pg.Pool;
  /**
   * Resolve the group JIDs where the command is currently active
   * (group_command_permissions, DB-only). Called per candidate message — behind
   * the cheap `startsWith("/")` pre-gate — so a toggle-off in the UI takes
   * effect on the very next message, in every process topology (no in-memory
   * cache, no reload channel needed).
   */
  resolveEnabledJids: () => Promise<ReadonlySet<string>>;
  /**
   * Resolve the current trigger text (user_preferences, falling back to
   * DEFAULT_SUMMARY_TRIGGER). Read per candidate message for the same reason as
   * resolveEnabledJids.
   */
  resolveTrigger: () => Promise<string>;
  /** Sends the reply back into the group; returns the sent message so it can be quoted next time. */
  sendText: (
    jid: string,
    text: string,
    opts?: { quoted?: WAMessage },
  ) => Promise<WAMessage | undefined>;
  /** Optional: react to the command message (⏳ working, ✅ done). Best-effort. */
  react?: (jid: string, key: WAMessage["key"], emoji: string) => Promise<void>;
  /** Per-group in-flight lock, shared across calls, to serialize Ollama runs. */
  inFlight: Set<number>;
  /** Reconstruct a quotable message from a stored id + text (CollectorSession.quotedFrom). */
  makeQuoted?: (jid: string, waMessageId: string, text: string) => WAMessage;
  /**
   * Resolve a `@lid` chat id to its phone JID (CollectorSession.pnForLid). 1:1
   * chats are delivered live as `@lid`, but the whitelist/group store the
   * `@s.whatsapp.net` form — without this they'd never match. Groups use stable
   * `@g.us` and are unaffected.
   */
  resolvePn?: (lid: string) => Promise<string | null>;
  /**
   * The group's shared catch-up cursor and reply thread. One window per group:
   * whoever asks, the summary covers everything since the last successful
   * command, and the reply quotes the summary the group last received.
   * `resolveParticipantId` survives the switch to a shared cursor — it no longer
   * keys the window, only stamps `requesterId` on the summary row for adoption
   * metrics.
   */
  marks: {
    resolveParticipantId: (senderName: string) => Promise<number>;
    getMark: (groupId: number) => Promise<SummaryGroupMark | null>;
    /** Returns whether the write landed; the advance is monotonic and can refuse. */
    setMark: (m: {
      groupId: number;
      lastSummarizedAt: Date;
      lastSummaryId: number;
      lastReplyWaMessageId: string | null;
    }) => Promise<boolean>;
    getSummaryOutput: (summaryId: number) => Promise<SummaryOutput | null>;
  };
  /** In-memory fast path for the group's quote target, keyed by groupId. */
  lastSummaryByGroup?: Map<number, WAMessage>;
  /**
   * Generate the summary for the ALREADY-verified group id, on the caller's
   * tenant-scoped pool (wired to runSummarizeOnPool in prod). Keyed on groupId —
   * never re-resolves the group by name — so the summary can't cross chats or
   * tenants. Required; tests inject a fake.
   */
  runSummarize: (input: {
    groupId: number;
    selection: { last: number } | { since: Date };
    /** The asker, stamped onto the summary row for adoption metrics. */
    requesterId: number;
  }) => Promise<RunSummarizeResult>;
  log?: MinimalLog;
};

/** Range for a group that has no shared marker yet. */
const FALLBACK_LAST_N = 50;

/**
 * Only act on genuinely LIVE messages. The collector emits "message" for live
 * upserts AND for the recent-history / offline-queue batches replayed on every
 * reconnect (which auto-fires every few seconds on any blip). Without this
 * gate, a `/סיכום` in a replayed window would re-fire and send an unsolicited
 * reply. Live messages arrive within seconds; anything older is a replay.
 *
 * The gate is two-sided. `sentAt` is the sender's device clock, and it becomes
 * the group's shared cursor — so a forward-skewed clock would write a future
 * cursor that leaves every later /סיכום matching no messages, for everyone,
 * with no in-app recovery. A one-sided check missed that entirely: `now - sentAt`
 * is negative for a future message, which is never `> LIVENESS_WINDOW_MS`.
 */
const LIVENESS_WINDOW_MS = 120_000;

/**
 * If `msg` is a `/סיכום` command in an allowlisted group, generate and send the
 * catch-up reply. Returns true when a reply was sent, false otherwise (not a
 * command, not allowlisted, already running, empty, or an error — all handled
 * quietly so the ingest loop is never disrupted).
 */
export async function maybeHandleSummaryCommand(
  msg: WAMessage,
  deps: SummaryCommandDeps,
  now: () => number = Date.now,
): Promise<boolean> {
  const mapped = mapWaMessage(msg);
  if (!mapped) return false;

  const text = (mapped.textContent ?? "").trim();
  // Cheap pre-gate: every trigger starts with "/", so ordinary chatter never hits the DB.
  if (!text.startsWith("/")) return false;

  let trigger: string;
  let allowlist: ReadonlySet<string>;
  try {
    trigger = await deps.resolveTrigger();
    allowlist = await deps.resolveEnabledJids();
  } catch (err) {
    // Fail CLOSED: a DB error must never send. Strictly safer than the old
    // startup-read-fails-empty-forever behavior — this retries next message.
    deps.log?.warn({ err }, "failed to resolve /סיכום permissions; ignoring command");
    return false;
  }

  if (!isSummaryTrigger(text, trigger)) return false;
  // fromMe is intentionally allowed: the linked account is the primary user, so
  // typing /סיכום from your own phone must trigger. No loop risk — the reply is
  // a summary, never the command string, so it can't re-match above.

  // Canonicalize a 1:1 chat's @lid id to its phone JID, which is what the
  // whitelist and groups table store; groups (@g.us) pass through unchanged.
  let jid = mapped.remoteJid;
  if (jid.endsWith("@lid") && deps.resolvePn) {
    const pn = await deps.resolvePn(jid);
    if (pn) jid = pn;
  }
  if (!allowlist.has(jid)) return false;

  // Ignore replayed/history messages AND clock-skewed future ones (see
  // LIVENESS_WINDOW_MS) — act on live only.
  const drift = now() - mapped.sentAt.getTime();
  if (Math.abs(drift) > LIVENESS_WINDOW_MS) {
    deps.log?.info(
      { jid, sentAt: mapped.sentAt, driftMs: drift },
      drift > 0
        ? "summary command: stale (replay), skipping"
        : "summary command: future-dated (clock skew), skipping",
    );
    return false;
  }

  const { rows } = await deps.pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM groups WHERE whatsapp_id = $1 LIMIT 1`,
    [jid],
  );
  const group = rows[0];
  if (!group) {
    deps.log?.warn({ jid }, "summary command: group not found for JID");
    return false;
  }
  const groupId = Number(group.id);

  // Best-effort reaction (⏸ busy → ⏳ working → ✅ done → ❌ failed); never throws.
  // Defined ABOVE the in-flight guard so the guard can ack before returning —
  // it used to drop a concurrent /סיכום in total silence, the same defect the
  // @Aida path had (they are mirrored on purpose, so they regressed together).
  const react = async (emoji: string) => {
    try {
      await deps.react?.(jid, msg.key, emoji);
    } catch {
      /* reactions are cosmetic — ignore failures */
    }
  };

  if (deps.inFlight.has(groupId)) {
    // ⏸, not ⏳: this request is dropped, not queued. See ask-command.ts.
    await react("⏸");
    deps.log?.info({ groupId }, "summary command: already generating, skipping");
    return false;
  }
  deps.inFlight.add(groupId);
  try {
    await react("⏳");

    // Identify the asker → their participant (same keying ingest used, so it
    // resolves the existing id). senderName falls back to the JID defensively.
    // This no longer keys the window; it only stamps requesterId below.
    const senderName = (mapped.senderName ?? "").trim() || jid;
    const participantId = await deps.marks.resolveParticipantId(senderName);
    const groupMark = await deps.marks.getMark(groupId);

    // One anchor: the group's shared cursor. No summaries.created_at fallback —
    // see the header. A group that has never run the command gets a last-N window.
    const selection = groupMark ? { since: groupMark.lastSummarizedAt } : { last: FALLBACK_LAST_N };

    const result = await deps.runSummarize({ groupId, selection, requesterId: participantId });
    const text =
      result.kind === "empty"
        ? EMPTY_REPLY
        : buildWhatsAppReply(result.output, {
            coveredFrom: result.coveredFrom,
            droppedCount: result.droppedCount,
          });

    // Quote the GROUP's previous summary so the thread reads as one chain.
    // Prefer the live in-memory message; else reconstruct it from the marker
    // (survives a restart); else quote the /סיכום request.
    let quoted = deps.lastSummaryByGroup?.get(groupId);
    if (!quoted && groupMark?.lastSummaryId && groupMark.lastReplyWaMessageId && deps.makeQuoted) {
      // Isolated: this lookup only rebuilds quote TEXT. Letting it throw past
      // here would discard an already-generated summary over a decoration —
      // and `lastSummaryId` is documented as "null if purged", so the row going
      // missing is expected operation, not an exceptional case.
      try {
        const out = await deps.marks.getSummaryOutput(groupMark.lastSummaryId);
        if (out)
          quoted = deps.makeQuoted(jid, groupMark.lastReplyWaMessageId, buildWhatsAppReply(out));
        else deps.log?.info({ groupId }, "summary command: previous summary gone, quoting request");
      } catch (err) {
        deps.log?.warn({ err, groupId }, "summary command: quote rebuild failed, quoting request");
      }
    }

    const sent = await deps.sendText(jid, text, { quoted: quoted ?? msg });

    // Only a real summary advances the shared cursor / thread (an empty "nothing
    // new" reply is not a thread anchor and has no summary row to point at).
    if (result.kind === "ok") {
      if (!sent?.key?.id) {
        // Nothing to anchor the thread on and nothing to prove delivery, so the
        // cursor cannot move — but the reply may well have gone out. Silence here
        // reads as success in the logs while the group re-summarizes the same
        // window on every subsequent command.
        deps.log?.warn(
          { groupId, summaryId: result.summaryId },
          "summary command: send returned no confirmable message id; cursor did not advance, the next /סיכום will repeat this window",
        );
      } else {
        // The summary is already delivered — a failure from here on is an
        // operator problem, not a user-facing one. Falling through to the outer
        // catch would post ERROR_REPLY directly beneath a good summary.
        try {
          const advanced = await deps.marks.setMark({
            groupId,
            lastSummarizedAt: mapped.sentAt,
            lastSummaryId: result.summaryId,
            lastReplyWaMessageId: sent.key.id,
          });
          // Cache only AFTER the durable write, so the in-memory quote target can
          // never point past the cursor that decides the window.
          if (advanced) deps.lastSummaryByGroup?.set(groupId, sent);
          else
            deps.log?.warn(
              { groupId, lastSummarizedAt: mapped.sentAt },
              "summary command: cursor did not advance — the stored mark is not older than this command",
            );
        } catch (err) {
          deps.log?.warn(
            { err, groupId, summaryId: result.summaryId },
            "summary command: reply sent but the cursor did not advance; the next /סיכום will repeat this window",
          );
        }
      }
    }

    await react("✅");
    deps.log?.info({ groupId, participantId, kind: result.kind }, "summary command: replied");
    return true;
  } catch (err) {
    deps.log?.warn({ err, groupId }, "summary command: failed");
    await react("❌");
    // Don't fail silently — a no-op reads as "the bot is broken". Best-effort.
    try {
      await deps.sendText(jid, ERROR_REPLY, { quoted: msg });
    } catch {
      /* ignore — reply is best-effort */
    }
    return false;
  } finally {
    deps.inFlight.delete(groupId);
  }
}

// ── WhatsApp formatting ──────────────────────────────────────────────────────

/**
 * Build the WhatsApp reply from the summary's NORMALIZED sections with fixed
 * emoji headers — not from the model's raw markdown. The local model emits the
 * `## תקציר` / `## נושאים עיקריים` headings only sometimes, so keying emojis off
 * its heading text gave inconsistent results (short summaries came out as bare
 * prose, no emoji). `normalizeSummaryOutput` parses both structured and legacy
 * rows into the same sections; `tldr` is always populated, so every reply gets
 * at least 📝 *תקציר*, and richer summaries add the other section emojis.
 */
/**
 * The "מסכם מ־…" line at the top of the reply, so the reader knows WHICH window
 * the summary covers instead of having to guess.
 *
 * `coveredFrom` is the oldest message actually summarized — NOT the requested
 * window start. When the token budget trims a wide selection, the two differ, and
 * printing the request would claim coverage the summary does not have. When
 * messages were dropped, that is stated outright rather than left implicit.
 */
function buildWindowHeader(window: SummaryWindow): string {
  const when = window.coveredFrom.toLocaleString("he-IL", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const dropped = window.droppedCount > 0 ? ` · ${window.droppedCount} הודעות ישנות לא נכללו` : "";
  return `🕐 _מסכם מ־${when}${dropped}_`;
}

/** What the reply says about its own coverage. */
export type SummaryWindow = {
  /** sent_at of the OLDEST message actually summarized. */
  coveredFrom: Date;
  /** Messages the token budget forced out of this summary. */
  droppedCount: number;
};

export function buildWhatsAppReply(output: SummaryOutput, window?: SummaryWindow): string {
  const n = normalizeSummaryOutput(output);
  const header = window ? buildWindowHeader(window) : null;
  const parts: string[] = [];
  const push = (emoji: string, title: string, body: string) => {
    const b = body.trim();
    if (b) parts.push(`${emoji} *${title}*\n${b}`);
  };
  const bullets = (items: SummaryBullet[]) =>
    items
      .map((it) => waInline(it.text))
      .filter((t) => t.length > 0)
      .map((t) => `• ${t}`)
      .join("\n");

  push("📝", "תקציר", formatSummaryForWhatsApp(n.tldr));
  push("📌", "נושאים עיקריים", bullets(n.topics));
  push("✅", "החלטות ומשימות", bullets([...n.decisions, ...n.actionItems]));
  push("❓", "שאלות פתוחות", bullets(n.openQuestions));

  // Fallback: if normalization yielded no sections (shouldn't happen — tldr is
  // populated for any non-empty summary), send the raw overview reshaped. The
  // header is checked against the SECTIONS, not the header itself, so a
  // header-only reply can never be mistaken for a real summary.
  const body = parts.length === 0 ? formatSummaryForWhatsApp(n.overview) : parts.join("\n\n");
  return header ? `${header}\n\n${body}` : body;
}

/** Reshape a single inline fragment: strip citations, `**bold**` → `*bold*`. */
function waInline(s: string): string {
  return stripCitations(String(s ?? ""))
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .trim();
}

// ponytail: formatSummaryForWhatsApp is the fallback / raw-markdown reshaper — a
// faithful server-side twin of src/web/public/lib/markdown.js#toWhatsAppText.
// Keep them in sync.

/** Known Hebrew section headers → their WhatsApp emoji prefix. */
const HEADING_EMOJI: Record<string, string> = {
  תקציר: "📝",
  "נושאים עיקריים": "📌",
  "החלטות ומשימות": "✅",
  "שאלות פתוחות": "❓",
  "לפי משתתף": "👤",
};

/**
 * Strip source citations from a WhatsApp fragment.
 *
 * Delegates to the summarization layer's stripper rather than keeping a third
 * private copy of the same regexes. The private copy is what leaked `^` into the
 * live /סיכום reply: like the two it duplicated, both of its patterns required a
 * digit after the caret, so the model's frequent index-less `^` sailed through —
 * fixing the shared stripper did nothing for the one surface that mattered most.
 */
function stripCitations(text: string): string {
  return stripAllMarkers(text).text;
}

/** Reshape a summary's overview markdown into WhatsApp-native plain text. */
export function formatSummaryForWhatsApp(overview: string): string {
  if (overview == null || String(overview).trim() === "") return "";
  const lines = stripCitations(String(overview))
    .split("\n")
    .map((line) => {
      const heading = line.match(/^(#{2,3})\s+(.*)$/);
      if (heading) {
        const title = heading[2]!.trim();
        const emoji = HEADING_EMOJI[title];
        return emoji ? `${emoji} *${title}*` : `*${title}*`;
      }
      if (line.startsWith("- ") || line.startsWith("* ")) return `• ${line.slice(2)}`;
      return line;
    });
  return lines
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
