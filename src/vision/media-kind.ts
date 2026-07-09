/**
 * Media-kind predicates and helpers for visual media (images and video).
 *
 * SQL fragments are exported so the repository layer reuses the exact same
 * file-extension logic rather than re-deriving it independently.
 *
 * Predicate fragments reference the alias `m` (the `messages` table) — callers
 * must join/alias accordingly, mirroring AUDIO_PREDICATE in transcripts.ts.
 */

// ---------------------------------------------------------------------------
// SQL predicate fragments
// ---------------------------------------------------------------------------

/** Image extensions we attempt to visually describe. */
export const IMAGE_PREDICATE = `(
  lower(m.media_filename) LIKE '%.jpg'  OR
  lower(m.media_filename) LIKE '%.jpeg' OR
  lower(m.media_filename) LIKE '%.png'  OR
  lower(m.media_filename) LIKE '%.gif'  OR
  lower(m.media_filename) LIKE '%.webp'
)`;

/** Video extensions we attempt to visually describe. */
export const VIDEO_PREDICATE = `(
  lower(m.media_filename) LIKE '%.mp4' OR
  lower(m.media_filename) LIKE '%.mov'
)`;

// ---------------------------------------------------------------------------
// TypeScript helpers
// ---------------------------------------------------------------------------

/**
 * Derive the visual media kind from a filename.
 * Returns 'image' | 'video' | null (null for audio, unknown, or missing name).
 */
export function kindFromFilename(filename: string | null | undefined): "image" | "video" | null {
  if (!filename) return null;
  const lower = filename.toLowerCase();
  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp")
  ) {
    return "image";
  }
  if (lower.endsWith(".mp4") || lower.endsWith(".mov")) {
    return "video";
  }
  return null;
}

/**
 * Returns true if the media message represents a sticker and should be
 * excluded from visual analysis enqueueing.
 *
 * @param filename       - The media_filename column value (may be null for live messages).
 * @param isStickerFlag  - Explicit sticker flag from the message type / Baileys classification.
 *                         When true, always returns true regardless of filename.
 */
export function isSticker(filename: string | null | undefined, isStickerFlag?: boolean): boolean {
  if (isStickerFlag === true) return true;
  return false;
}
