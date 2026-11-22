/**
 * media-kind.ts — which media a WhatsApp message carries, as one PURE switch.
 *
 * Split from media-descriptor.ts so the message mapper (and everything that maps
 * a message without downloading it — Rosey's capture, her sandbox) never loads
 * Baileys at runtime: this file imports only Baileys' TYPES, which compile away.
 * media-descriptor.ts, which needs Baileys' `proto` to encode the download blob,
 * imports it from here.
 */
import type { WAMessage } from "@whiskeysockets/baileys";

export type MediaKind = "image" | "video" | "audio" | "sticker" | "document";

export type MediaContent = {
  mediaKey?: Uint8Array | null;
  directPath?: string | null;
  url?: string | null;
  mimetype?: string | null;
  fileEncSha256?: Uint8Array | null;
  fileSha256?: Uint8Array | null;
  mediaKeyTimestamp?: number | { toNumber(): number } | null;
  fileLength?: number | { toNumber(): number } | null;
};

/**
 * Classify a Baileys message into its media {@link MediaKind} and the raw
 * content node, or null when it carries no downloadable media. This is the
 * single place the imageMessage/videoMessage/audioMessage/stickerMessage/
 * documentMessage union is switched — the message mapper reads `.kind` for its
 * `mediaKind` discriminant, media-descriptor reads `.content` for the download blob.
 */
export function classifyMedia(
  msg: NonNullable<WAMessage["message"]>,
): { kind: MediaKind; content: MediaContent } | null {
  if (msg.imageMessage) return { kind: "image", content: msg.imageMessage as MediaContent };
  if (msg.videoMessage) return { kind: "video", content: msg.videoMessage as MediaContent };
  if (msg.audioMessage) return { kind: "audio", content: msg.audioMessage as MediaContent };
  if (msg.stickerMessage) return { kind: "sticker", content: msg.stickerMessage as MediaContent };
  if (msg.documentMessage)
    return { kind: "document", content: msg.documentMessage as MediaContent };
  return null;
}
