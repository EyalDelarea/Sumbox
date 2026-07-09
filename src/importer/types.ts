export type ImportedMessageType = "text" | "media" | "system";

export type ImportedMessage = {
  senderName: string | null;
  sentAt: Date;
  messageType: ImportedMessageType;
  textContent: string;
  mediaFilename: string | null;
  /** Whether the message was sent by the device owner; null/undefined for import rows. */
  fromMe?: boolean | null;
};

/**
 * Row-shaped type produced by the normalizer — ready for DB insertion.
 * Carries all fields needed to insert into the `messages` table, except
 * `participantId` which is resolved separately via the participants repo.
 */
export type NormalizedMessage = {
  groupId: number;
  importId: number | null;
  source: "import" | "live";
  /** Display name of the sender, or null for system messages. */
  senderName: string | null;
  messageType: ImportedMessageType;
  /** Trimmed body; null for pure media rows with no body text. */
  textContent: string | null;
  mediaFilename: string | null;
  /**
   * Absolute or relative path where the media file was stored on disk.
   * null for non-media messages or when media is missing from the export.
   */
  mediaPath: string | null;
  /**
   * 'present'  — file found in the export and written to disk.
   * 'missing'  — media referenced in the chat text but absent from the export.
   * null       — not a media message.
   */
  mediaStatus: "present" | "missing" | null;
  sentAt: Date;
  dedupeKey: string;
  /** Baileys message id (live only); null for imported messages. */
  externalId: string | null;
  /** Whether the message was sent by the device owner; null for legacy/import rows. */
  fromMe?: boolean | null;
};

export type ImportResult = {
  groupName: string;
  messageCount: number;
  mediaCount: number;
};
