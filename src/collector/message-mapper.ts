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
  sentAt: Date;
  messageType: ImportedMessageType;
  textContent: string | null;
  mediaFilename: string | null;
  /** True when the underlying Baileys message is an audioMessage (voice note). */
  isVoiceNote: boolean;
  /** True when the underlying Baileys message is an imageMessage. */
  isImage: boolean;
  /** True when the underlying Baileys message is a videoMessage. */
  isVideo: boolean;
  /** True when the underlying Baileys message is a stickerMessage. */
  isSticker: boolean;
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
    sentAt,
    messageType: mapped.messageType,
    textContent: mapped.textContent,
    mediaFilename: mapped.mediaFilename,
    isVoiceNote: mapped.isVoiceNote,
    isImage: mapped.isImage,
    isVideo: mapped.isVideo,
    isSticker: mapped.isSticker,
    jpegThumbnail: mapped.jpegThumbnail,
    fromMe: key.fromMe ?? false,
  };
}

type ContentResult = {
  messageType: ImportedMessageType;
  textContent: string | null;
  mediaFilename: string | null;
  isVoiceNote: boolean;
  isImage: boolean;
  isVideo: boolean;
  isSticker: boolean;
  jpegThumbnail: Buffer | null;
};

/**
 * Resolve the content fields from a Baileys IMessage.
 * Returns null if we cannot map the content to a known type.
 */
function resolveContent(msg: NonNullable<WAMessage["message"]>): ContentResult | null {
  // Simple text (conversation)
  if (msg.conversation) {
    return {
      messageType: "text",
      textContent: msg.conversation,
      mediaFilename: null,
      isVoiceNote: false,
      isImage: false,
      isVideo: false,
      isSticker: false,
      jpegThumbnail: null,
    };
  }

  // Extended text message (replies, links, etc.)
  if (msg.extendedTextMessage?.text) {
    return {
      messageType: "text",
      textContent: msg.extendedTextMessage.text,
      mediaFilename: null,
      isVoiceNote: false,
      isImage: false,
      isVideo: false,
      isSticker: false,
      jpegThumbnail: null,
    };
  }

  // Audio / voice note
  if (msg.audioMessage) {
    return {
      messageType: "media",
      textContent: null,
      mediaFilename: null,
      isVoiceNote: true,
      isImage: false,
      isVideo: false,
      isSticker: false,
      jpegThumbnail: null,
    };
  }

  // Image message
  if (msg.imageMessage) {
    const caption = msg.imageMessage.caption ?? null;
    return {
      messageType: "media",
      textContent: caption || null,
      mediaFilename: null,
      isVoiceNote: false,
      isImage: true,
      isVideo: false,
      isSticker: false,
      jpegThumbnail: null,
    };
  }

  // Video message
  if (msg.videoMessage) {
    const caption = msg.videoMessage.caption ?? null;
    // Extract embedded thumbnail bytes (Uint8Array → Buffer)
    const thumbBytes = (msg.videoMessage as { jpegThumbnail?: Uint8Array | null }).jpegThumbnail;
    const jpegThumbnail = thumbBytes && thumbBytes.length > 0 ? Buffer.from(thumbBytes) : null;
    return {
      messageType: "media",
      textContent: caption || null,
      mediaFilename: null,
      isVoiceNote: false,
      isImage: false,
      isVideo: true,
      isSticker: false,
      jpegThumbnail,
    };
  }

  // Document message
  if (msg.documentMessage) {
    return {
      messageType: "media",
      textContent: null,
      mediaFilename: (msg.documentMessage.fileName as string | undefined | null) ?? null,
      isVoiceNote: false,
      isImage: false,
      isVideo: false,
      isSticker: false,
      jpegThumbnail: null,
    };
  }

  // Sticker
  if (msg.stickerMessage) {
    return {
      messageType: "media",
      textContent: null,
      mediaFilename: null,
      isVoiceNote: false,
      isImage: false,
      isVideo: false,
      isSticker: true,
      jpegThumbnail: null,
    };
  }

  // Unrecognized / unhandled message types (e.g. pollMessage, eventMessage, etc.)
  // Note: these are silently ignored; the caller receives null and can log.
  // Common unhandled types: pollCreationMessage, groupInviteMessage, contactMessage, locationMessage
  return null;
}
