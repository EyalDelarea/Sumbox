/**
 * message-mapper.ts — PURE mapping from Baileys WAMessage to our domain shape.
 *
 * No database, no sockets. Fully testable in isolation.
 *
 * Returns null for messages to ignore (status broadcasts, protocol/system messages,
 * messages with no recognizable content, messages missing a key.id).
 */
import type { WAMessage } from "@whiskeysockets/baileys";
import type { ImportedMessageType } from "../importer/types.js";
import { classifyMedia, type MediaKind } from "./media-descriptor.js";
import { timestampToMs } from "./timestamp.js";

export type MappedMessage = {
  externalId: string;
  remoteJid: string;
  /**
   * The alternate identity WhatsApp ships on the message key (`key.remoteJidAlt`):
   * the `@lid` for a phone-JID chat, or vice versa. Null when absent. Used at
   * ingest as the lid<->pn fallback when Baileys' mapping store isn't yet warm.
   */
  remoteJidAlt: string | null;
  senderName: string;
  /**
   * The author's JID (`key.participant` in a group, the chat jid in a 1:1), or
   * null when WhatsApp ships neither. Stored so a message can be quote-replied
   * with correct attribution — Baileys builds a quote's author from this, and a
   * display_name cannot be reversed into it.
   */
  senderJid: string | null;
  sentAt: Date;
  messageType: ImportedMessageType;
  textContent: string | null;
  mediaFilename: string | null;
  /**
   * The kind of media this message carries, or null for text. One discriminant
   * in place of the former isVoiceNote/isImage/isVideo/isSticker booleans
   * ("audio" is a voice note); "document" is now explicit rather than implied by
   * all-four-false. Derived from the shared classifyMedia().
   */
  mediaKind: MediaKind | null;
  /**
   * Embedded JPEG thumbnail bytes for a video message, if present.
   * Used as a fallback when the video itself is oversized or cannot be downloaded.
   */
  jpegThumbnail: Buffer | null;
  /** Whether the message was sent by the device owner (from waMessage.key.fromMe). */
  fromMe: boolean;
};

/**
 * Map a Baileys WAMessage to our MappedMessage domain shape.
 *
 * Returns null for:
 * - Messages to/from status@broadcast (status updates)
 * - Protocol/system messages (revoke, app state sync, etc.)
 * - Messages with no key.id
 * - Messages with no recognizable content
 */
export function mapWaMessage(waMessage: WAMessage): MappedMessage | null {
  const key = waMessage.key;

  // Must have a stable id
  if (!key?.id) {
    return null;
  }

  const remoteJid = key.remoteJid;
  if (!remoteJid) {
    return null;
  }

  // Ignore status broadcasts
  if (remoteJid === "status@broadcast") {
    return null;
  }

  const msg = waMessage.message;
  if (!msg) {
    return null;
  }

  // Ignore protocol messages (message revoke, app state, etc.)
  if (msg.protocolMessage) {
    return null;
  }

  // Ignore reaction messages
  if (msg.reactionMessage) {
    return null;
  }

  // Resolve sender name: pushName > key.participant > fallback
  const senderName: string =
    (waMessage.pushName as string | undefined) ?? key.participant ?? remoteJid;

  /**
   * The AUTHOR's own JID, kept as an identity rather than folded into a name.
   *
   * In a group the author is key.participant; in a 1:1 the chat jid IS the
   * person. senderName above may collapse to the same string, but only by
   * accident when pushName is missing — a display name cannot be turned back
   * into a JID, so quoting someone's message needs this stored separately.
   */
  const senderJid: string | null =
    key.participant ?? (remoteJid.endsWith("@g.us") ? null : remoteJid);

  // Resolve timestamp
  const sentAt = new Date(timestampToMs(waMessage.messageTimestamp));

  // Map content
  const mapped = resolveContent(msg);
  if (!mapped) {
    return null;
  }

  // `remoteJidAlt` carries the person's other identity (lid<->pn). It is present
  // on the Baileys runtime key but not always in the static type, so read it
  // defensively.
  const remoteJidAlt = (key as { remoteJidAlt?: string | null }).remoteJidAlt ?? null;

  return {
    externalId: key.id,
    remoteJid,
    remoteJidAlt,
    senderName,
    senderJid,
    sentAt,
    messageType: mapped.messageType,
    textContent: mapped.textContent,
    mediaFilename: mapped.mediaFilename,
    mediaKind: mapped.mediaKind,
    jpegThumbnail: mapped.jpegThumbnail,
    fromMe: key.fromMe ?? false,
  };
}

type ContentResult = {
  messageType: ImportedMessageType;
  textContent: string | null;
  mediaFilename: string | null;
  mediaKind: MediaKind | null;
  jpegThumbnail: Buffer | null;
};

/**
 * Resolve the content fields from a Baileys IMessage.
 * Returns null if we cannot map the content to a known type.
 */
function resolveContent(msg: NonNullable<WAMessage["message"]>): ContentResult | null {
  // Text is checked first (before media), preserving the original precedence.
  if (msg.conversation) {
    return textResult(msg.conversation);
  }
  if (msg.extendedTextMessage?.text) {
    return textResult(msg.extendedTextMessage.text);
  }

  // Every media kind flows through the shared classifier (the single place the
  // Baileys media union is switched). Unrecognized types (pollMessage,
  // groupInviteMessage, contactMessage, locationMessage, …) return null and the
  // caller logs/ignores them.
  const media = classifyMedia(msg);
  if (!media) {
    return null;
  }

  switch (media.kind) {
    case "audio":
      return mediaResult("audio", { textContent: null });
    case "image":
      return mediaResult("image", { textContent: msg.imageMessage?.caption || null });
    case "video": {
      const video = msg.videoMessage;
      // Extract embedded thumbnail bytes (Uint8Array → Buffer) for the
      // download-failure fallback.
      const thumbBytes = (video as { jpegThumbnail?: Uint8Array | null } | null | undefined)
        ?.jpegThumbnail;
      const jpegThumbnail = thumbBytes && thumbBytes.length > 0 ? Buffer.from(thumbBytes) : null;
      return mediaResult("video", { textContent: video?.caption || null, jpegThumbnail });
    }
    case "document":
      return mediaResult("document", {
        mediaFilename: (msg.documentMessage?.fileName as string | undefined | null) ?? null,
      });
    case "sticker":
      return mediaResult("sticker", { textContent: null });
  }
}

function textResult(textContent: string): ContentResult {
  return {
    messageType: "text",
    textContent,
    mediaFilename: null,
    mediaKind: null,
    jpegThumbnail: null,
  };
}

function mediaResult(
  mediaKind: MediaKind,
  over: Partial<Pick<ContentResult, "textContent" | "mediaFilename" | "jpegThumbnail">>,
): ContentResult {
  return {
    messageType: "media",
    textContent: over.textContent ?? null,
    mediaFilename: over.mediaFilename ?? null,
    mediaKind,
    jpegThumbnail: over.jpegThumbnail ?? null,
  };
}
