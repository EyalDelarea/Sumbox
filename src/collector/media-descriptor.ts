/**
 * media-descriptor.ts — PURE extraction of the fields needed to (re)download a
 * media message later, plus a proto-encoded blob of the whole WAMessage.
 *
 * No DB, no socket. The minimal download set is mediaKey + (directPath|url) +
 * kind; the remaining fields are stored for integrity/metadata. The proto blob
 * round-trips the full message so the backfill loop can hand it straight to
 * Baileys' downloadMediaMessage (which needs message.key for reuploadRequest).
 */
import type { WAMessage } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";

export type MediaKind = "image" | "video" | "audio" | "sticker" | "document";

export type MediaDescriptor = {
  mediaKind: MediaKind;
  mimeType: string | null;
  mediaKey: Uint8Array | null;
  directPath: string | null;
  url: string | null;
  fileEncSha256: Uint8Array | null;
  fileSha256: Uint8Array | null;
  mediaKeyTs: number | null;
  fileLength: number | null;
  /**
   * Expiry of the signed CDN URL, in unix SECONDS, parsed from the `oe=` query
   * param (hex). After this instant the CDN returns 403 and — because the
   * `reuploadRequest` refresh path is broken — the media is unrecoverable. Used
   * to order the download queue by remaining lifetime and to skip dead rows.
   * Null when the URL/directPath carries no `oe`.
   */
  urlExpiresAt: number | null;
  /** proto.WebMessageInfo-encoded bytes of the full message (the blob). */
  waMessage: Uint8Array;
};

type MediaContent = {
  mediaKey?: Uint8Array | null;
  directPath?: string | null;
  url?: string | null;
  mimetype?: string | null;
  fileEncSha256?: Uint8Array | null;
  fileSha256?: Uint8Array | null;
  mediaKeyTimestamp?: number | { toNumber(): number } | null;
  fileLength?: number | { toNumber(): number } | null;
};

function toNum(v: number | { toNumber(): number } | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") return v.toNumber();
  return Number(v);
}

/** Pull the `oe=<hex>` signed-URL expiry (unix seconds) out of a URL/directPath. */
function parseOeExpiry(...candidates: (string | null | undefined)[]): number | null {
  for (const s of candidates) {
    const m = s?.match(/[?&]oe=([0-9A-Fa-f]+)/);
    if (m) {
      const secs = parseInt(m[1], 16);
      if (Number.isFinite(secs) && secs > 0) return secs;
    }
  }
  return null;
}

/**
 * Classify a Baileys message into its media {@link MediaKind} and the raw
 * content node, or null when it carries no downloadable media. This is the
 * single place the imageMessage/videoMessage/audioMessage/stickerMessage/
 * documentMessage union is switched — the message mapper reads `.kind` for its
 * `mediaKind` discriminant, this module reads `.content` for the download blob.
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

export function extractMediaDescriptor(waMessage: WAMessage): MediaDescriptor | null {
  const msg = waMessage.message;
  if (!msg) return null;
  const picked = classifyMedia(msg);
  if (!picked) return null;
  const c = picked.content;

  return {
    mediaKind: picked.kind,
    mimeType: c.mimetype ?? null,
    mediaKey: c.mediaKey ?? null,
    directPath: c.directPath ?? null,
    url: c.url ?? null,
    fileEncSha256: c.fileEncSha256 ?? null,
    fileSha256: c.fileSha256 ?? null,
    mediaKeyTs: toNum(c.mediaKeyTimestamp),
    fileLength: toNum(c.fileLength),
    urlExpiresAt: parseOeExpiry(c.directPath, c.url),
    waMessage: proto.WebMessageInfo.encode(waMessage as proto.IWebMessageInfo).finish(),
  };
}
