import crypto from "node:crypto";
import type { ImportedMessage, NormalizedMessage } from "./types.js";

type NormalizeContext = {
  groupId: number;
  importId: number | null;
  source: "import" | "live";
  /** Per-message external ids (Baileys ids for live messages). Indexed by position. */
  externalIds?: (string | null)[];
};

/**
 * Normalize an array of parsed ImportedMessages into NormalizedMessage rows
 * ready for DB insertion.
 *
 * Dedupe key formula (research R1):
 *   sha256(group_id + ' ' + sent_at_iso + ' ' + sender_name + ' ' + normalized_text + ' ' + media_filename)
 *
 * Where:
 *   - sent_at_iso    = Date.toISOString()
 *   - sender_name    = display name, or '' for system messages (null sender)
 *   - normalized_text = textContent trimmed and whitespace-collapsed
 *   - media_filename  = mediaFilename or '' when none
 */
export function normalize(messages: ImportedMessage[], ctx: NormalizeContext): NormalizedMessage[] {
  return messages.map((msg, idx) => {
    const senderName = msg.senderName; // null for system messages
    const normalizedText = normalizeText(msg.textContent);
    const mediaFilename = msg.mediaFilename ?? null;

    const dedupeKey = computeDedupeKey(
      ctx.groupId,
      msg.sentAt,
      senderName,
      normalizedText,
      mediaFilename,
    );

    // textContent: trimmed non-empty string, or null for pure-media rows with no body
    const textContent = resolveTextContent(msg, normalizedText);

    // externalId: provided per-message for live messages, null for imports
    const externalId = ctx.externalIds ? (ctx.externalIds[idx] ?? null) : null;

    return {
      groupId: ctx.groupId,
      importId: ctx.importId,
      source: ctx.source,
      senderName,
      messageType: msg.messageType,
      textContent,
      mediaFilename,
      mediaPath: null,
      mediaStatus: null,
      sentAt: msg.sentAt,
      dedupeKey,
      externalId,
      fromMe: msg.fromMe ?? null,
      senderJid: msg.senderJid ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Normalize text: trim + collapse internal whitespace runs to single spaces.
 * Returns empty string if input is empty/whitespace-only.
 */
function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Compute dedupe key per research R1 (verbatim).
 */
function computeDedupeKey(
  groupId: number,
  sentAt: Date,
  senderName: string | null,
  normalizedText: string,
  mediaFilename: string | null,
): string {
  const sentAtIso = sentAt.toISOString();
  const sender = senderName ?? "";
  const media = mediaFilename ?? "";

  const input = `${groupId} ${sentAtIso} ${sender} ${normalizedText} ${media}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Resolve textContent:
 * - For pure media rows (messageType='media') with no body text → null
 * - Otherwise → normalized (trimmed, whitespace-collapsed) text, or null if empty
 */
function resolveTextContent(msg: ImportedMessage, normalizedText: string): string | null {
  if (msg.messageType === "media" && normalizedText === "") {
    return null;
  }
  return normalizedText === "" ? null : normalizedText;
}
