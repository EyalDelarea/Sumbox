/**
 * collector.ts — Map incoming Baileys messages → normalize → persist.
 *
 * Core function: handleIncomingMessage
 * - Maps the WAMessage using message-mapper (pure, no DB)
 * - Upserts the group by JID (source='live'; upgrades to 'mixed' if it was 'import')
 * - Upserts the participant
 * - Normalizes the message (source='live', externalId set)
 * - Inserts into messages table
 * - Returns true if a new row was stored, false if it was a duplicate
 */

import fs from "node:fs";
import path from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import {
  isDisplayNameUnresolved,
  updateDisplayName,
  upsertGroupByCanonicalJid,
} from "../db/repositories/groups.js";
import { recordLink, siblingForJid } from "../db/repositories/identity-links.js";
import { getMessageIdByExternalId, insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import { normalize } from "../importer/normalize.js";
import type { ImportedMessage, NormalizedMessage } from "../importer/types.js";
import type { JobBus } from "../jobs/job-bus.js";
import type { Logger } from "../logging/logger.js";
import { isGoneError, statusOf } from "./media-backfill-loop.js";
import { extractMediaDescriptor, type MediaDescriptor } from "./media-descriptor.js";
import { type MappedMessage, mapWaMessage } from "./message-mapper.js";

/**
 * Media kinds that the analysis pipeline can handle. Only these kinds get a
 * `message_media` descriptor row — sticker and document rows are never
 * selected by `selectPendingMedia` and would sit in `'pending'` forever.
 */
const ANALYZABLE_MEDIA_KINDS = new Set(["image", "video", "audio"]);

export type CollectorOptions = {
  /** Root data directory (from config.dataDir). Live voice-note media is written
   *  under `<dataDir>/media/live/`. */
  dataDir: string;
  /**
   * Optional job bus. When provided, a `transcribe.voicenote` job is enqueued
   * for each newly-stored voice note **whose media was downloaded** (so the
   * worker always has a file to transcribe). When absent (the legacy `collect`
   * CLI path), the collector stores only.
   */
  bus?: JobBus;
  /**
   * Optional media downloader. When provided, voice-note audio is downloaded
   * and written to disk so it becomes transcribable (sets media_path +
   * media_status='present'). Injected so the collector stays testable without a
   * real Baileys socket; production wires this to the session's media download.
   * When absent, voice notes are stored without media (legacy behavior).
   */
  downloadVoiceNote?: (waMessage: WAMessage) => Promise<Buffer>;
  /**
   * Optional image downloader. When provided, non-sticker images are downloaded
   * and written to disk so they become analyzable (sets media_path +
   * media_status='present'). Injected so the collector stays testable without a
   * real Baileys socket; production wires this to the session's media download.
   * When absent, images are stored without media (not enqueued for analysis).
   */
  downloadImage?: (waMessage: WAMessage) => Promise<Buffer>;
  /**
   * Optional video downloader. When provided, non-sticker videos are downloaded
   * and written to disk so they become analyzable (sets media_path +
   * media_status='present'). When absent (or when download fails but a
   * jpegThumbnail is present), the thumbnail is persisted instead and
   * analyze.video is still enqueued. Injected for testability.
   */
  downloadVideo?: (waMessage: WAMessage) => Promise<Buffer>;
  /**
   * Optional group subject fetcher. When provided, the display name of a group
   * chat is resolved from WhatsApp on first sight (while the stored name is
   * still the raw JID). Injected so the collector stays testable without a real
   * Baileys socket; production wires this to session.groupSubject(jid).
   * When absent, display-name resolution for groups is skipped (legacy behavior).
   */
  groupSubject?: (jid: string) => Promise<string>;
  /**
   * Optional lid<->pn bridge. When provided, an incoming message's identity is
   * canonicalized at ingest so all of a person's messages land in ONE chat
   * regardless of which WhatsApp identity (@lid vs @s.whatsapp.net) it arrived
   * under — stopping LID-migration duplicates from re-forming (issue #17).
   * Production wires these to session.lidForPn / session.pnForLid. When absent,
   * the message is keyed on its raw remoteJid (legacy behavior).
   */
  lidForPn?: (pn: string) => Promise<string | null>;
  pnForLid?: (lid: string) => Promise<string | null>;
  /**
   * Optional descriptor sink. When provided, every media message's download
   * descriptor (proto blob + key/location) is persisted so the media can be
   * fetched later. `state` is 'present' when the media was downloaded inline
   * (live path), else 'pending' (onboarding/full-sync — deferred). Injected so
   * the collector stays DB-agnostic in unit tests; production wires it to
   * upsertMessageMedia. When absent, no descriptor is stored (legacy behavior).
   */
  persistMediaDescriptor?: (
    messageId: number,
    descriptor: MediaDescriptor,
    state: "pending" | "present",
  ) => Promise<void>;
  /**
   * Optional structured logger (a pino child, typically `getLogger("collector")`).
   * When provided, the collector routes its non-fatal warnings/diagnostics through
   * it — with `component`/`messageId` correlation context — instead of raw
   * `process.stderr`. Live media-download failures are level-classified: a
   * terminal CDN-gone error (403/404/410 — the signed URL expired or the blob was
   * GC'd) logs at `debug`, anything else at `warn`, mirroring the backfill loop.
   *
   * Injected (not imported via `getLogger` at module scope) so importing the
   * collector never spins up the pino transport — keeping the large collector
   * test suite fast. When absent, these diagnostics are dropped (no-op); existing
   * CLI/test paths that don't pass it keep working.
   */
  log?: Logger;
  /**
   * Gate analysis enqueues on chat selection. When provided, a group that returns
   * false is excluded from `transcribe.voicenote`, `analyze.image`, and
   * `analyze.video` jobs. Media is still downloaded and stored as
   * `media_status='present'` so a later include can analyze without re-download.
   *
   * When absent (single-user / legacy / test paths), every chat is treated as
   * included — preserving existing behavior and keeping all tests green.
   * Capture/download is never gated.
   */
  isGroupIncluded?: (groupId: number) => Promise<boolean>;
};

/**
 * Resolve the person's *other* identity (the lid<->pn sibling) for a 1:1 chat,
 * so an incoming message can be routed into an existing chat under either form.
 *
 * Priority order:
 * 1. Durable DB map (identity_links) — works even when Baileys is cold or in
 *    worker-only contexts (no live session).
 * 2. Live Baileys lid<->pn bridge — fast-path when the session is warm.
 * 3. Cold-store fallback: the alternate identity carried on the message key.
 *
 * Returns the sibling JID (or null) plus `learned`: true when the pairing came
 * from the live bridge / alt key (a NEW fact worth persisting), false when it was
 * already read from the DB map (already persisted — no re-write needed) or absent.
 * Returns null for group JIDs (@g.us — not part of LID migration). Never throws.
 */
async function resolveSiblingJid(
  client: pg.Pool | pg.PoolClient,
  remoteJid: string,
  remoteJidAlt: string | null,
  opts: CollectorOptions,
): Promise<{ jid: string | null; learned: boolean }> {
  // Group chats are not subject to LID migration.
  if (remoteJid.endsWith("@g.us")) return { jid: null, learned: false };

  // 1. Durable DB map first — already persisted, so nothing new to learn.
  try {
    const fromDb = await siblingForJid(client, remoteJid);
    if (fromDb && fromDb !== remoteJid) return { jid: fromDb, learned: false };
  } catch (e) {
    opts.log?.warn({ err: e, jid: remoteJid }, "identity-link sibling lookup failed");
  }

  // 2. Live Baileys lid<->pn mapping — a freshly learned pairing worth persisting.
  try {
    if (remoteJid.endsWith("@s.whatsapp.net") && opts.lidForPn) {
      const lid = await opts.lidForPn(remoteJid);
      if (lid && lid !== remoteJid) return { jid: lid, learned: true };
    } else if (remoteJid.endsWith("@lid") && opts.pnForLid) {
      const pn = await opts.pnForLid(remoteJid);
      if (pn && pn !== remoteJid) return { jid: pn, learned: true };
    }
  } catch {
    // Bridge failures must never break ingest — fall through to the alt key.
  }

  // 3. Cold-store fallback: the alternate identity carried on the message key.
  if (remoteJidAlt && remoteJidAlt !== remoteJid) return { jid: remoteJidAlt, learned: true };
  return { jid: null, learned: false };
}

/** Deterministic, filesystem-safe filename for a live voice note (keyed by the
 *  Baileys message id so re-delivery overwrites the same file). `.opus` so it
 *  matches the audio predicate the transcriber selects on. */
function liveVoiceNoteFilename(externalId: string | null): string {
  const safe = (externalId ?? `unknown-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
  return `live-${safe}.opus`;
}

/** Deterministic, filesystem-safe filename for a live image (keyed by the
 *  Baileys message id so re-delivery overwrites the same file). `.jpg` so it
 *  matches the IMAGE_PREDICATE the vision worker selects on. */
function liveImageFilename(externalId: string | null): string {
  const safe = (externalId ?? `unknown-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
  return `live-img-${safe}.jpg`;
}

/** Deterministic, filesystem-safe filename for a downloaded live video. `.mp4`
 *  matches the VIDEO_PREDICATE the vision worker selects on. */
function liveVideoFilename(externalId: string | null): string {
  const safe = (externalId ?? `unknown-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
  return `live-vid-${safe}.mp4`;
}

/** Deterministic, filesystem-safe filename for a video thumbnail (fallback when
 *  the video itself is oversized or cannot be downloaded). `.jpg` extension so
 *  it can be passed directly to the vision analyzer. */
function liveVideoThumbnailFilename(externalId: string | null): string {
  const safe = (externalId ?? `unknown-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
  return `live-vid-thumb-${safe}.jpg`;
}

/**
 * Log a live media-download failure at the right level. A terminal CDN-gone
 * failure (the signed URL's `oe` expiry passed, or the encrypted blob was
 * garbage-collected — 403/404/410) is expected and uninteresting, so it logs at
 * `debug`; every other failure is a real `warn`. Reuses the backfill loop's exact
 * gone/transient classification ({@link isGoneError}) so the two paths agree.
 * No-op when no logger was injected.
 */
function logDownloadFailure(
  log: Logger | undefined,
  kind: "voice-note" | "image" | "video",
  externalId: string | null,
  err: unknown,
): void {
  if (!log) return;
  const fields = { externalId, status: statusOf(err), err };
  if (isGoneError(err)) {
    log.debug(fields, `${kind} media gone (terminal) — skipping download`);
  } else {
    log.warn(fields, `failed to download ${kind} media`);
  }
}

/**
 * Per-media-kind spec driving the live download → persist → enqueue path for the
 * three analyzable kinds. Only audio/image/video have entries — sticker and
 * document are never downloaded or enqueued. Adding a downloadable kind is one
 * row here instead of another trio of near-identical inline blocks, and each
 * kind's failure/enqueue rules live together.
 */
type LiveMediaSpec = {
  /** Label passed to logDownloadFailure. */
  logLabel: "voice-note" | "image" | "video";
  /** The opts downloader for this kind (undefined → this kind isn't downloaded). */
  downloaderOf: (opts: CollectorOptions) => ((m: WAMessage) => Promise<Buffer>) | undefined;
  /** Deterministic on-disk filename (keyed by the Baileys id) for the download. */
  filenameFor: (externalId: string | null) => string;
  /**
   * Per-kind hook run when the download FAILS. Video persists the embedded
   * jpegThumbnail as an analyzable fallback and returns its path; others no-op.
   */
  onDownloadFailure?: (ctx: {
    mapped: MappedMessage;
    mediaDir: string;
    opts: CollectorOptions;
  }) => string | null;
  /** Whether to enqueue the analysis job, given the post-download state. */
  enqueueWhen: (ctx: {
    downloaderProvided: boolean;
    mediaStatus: NormalizedMessage["mediaStatus"];
    thumbnailPath: string | null;
  }) => boolean;
  /** Enqueue this kind's job (closes over the literal job type for clean typing). */
  enqueueJob: (bus: JobBus, messageId: string) => Promise<unknown>;
};

const LIVE_MEDIA_SPECS: Record<"audio" | "image" | "video", LiveMediaSpec> = {
  audio: {
    logLabel: "voice-note",
    downloaderOf: (o) => o.downloadVoiceNote,
    filenameFor: liveVoiceNoteFilename,
    // Enqueue only when the note is actually present on disk (no dead jobs).
    enqueueWhen: ({ mediaStatus }) => mediaStatus === "present",
    enqueueJob: (bus, messageId) => bus.enqueue("transcribe.voicenote", { messageId }),
  },
  image: {
    logLabel: "image",
    downloaderOf: (o) => o.downloadImage,
    filenameFor: liveImageFilename,
    // Enqueue only when a downloader was provided and the image is present.
    enqueueWhen: ({ downloaderProvided, mediaStatus }) =>
      downloaderProvided && mediaStatus === "present",
    enqueueJob: (bus, messageId) => bus.enqueue("analyze.image", { messageId }),
  },
  video: {
    logLabel: "video",
    downloaderOf: (o) => o.downloadVideo,
    filenameFor: liveVideoFilename,
    // On download failure, persist the embedded thumbnail as a fallback so the
    // video can still be described without the full file.
    onDownloadFailure: ({ mapped, mediaDir, opts }) => {
      if (!(mapped.jpegThumbnail && mapped.jpegThumbnail.length > 0)) return null;
      try {
        fs.mkdirSync(mediaDir, { recursive: true });
        const thumbPath = path.join(mediaDir, liveVideoThumbnailFilename(mapped.externalId));
        fs.writeFileSync(thumbPath, mapped.jpegThumbnail);
        return thumbPath;
      } catch (err) {
        opts.log?.warn({ err, externalId: mapped.externalId }, "failed to persist video thumbnail");
        return null;
      }
    },
    // Enqueue when the video is present OR a thumbnail was persisted (nothing to
    // describe when neither is available).
    enqueueWhen: ({ mediaStatus, thumbnailPath }) =>
      mediaStatus === "present" || thumbnailPath !== null,
    enqueueJob: (bus, messageId) => bus.enqueue("analyze.video", { messageId }),
  },
};

/** The spec for a mapped message's media kind, or undefined (text/sticker/document). */
function liveMediaSpecFor(mediaKind: MappedMessage["mediaKind"]): LiveMediaSpec | undefined {
  return mediaKind === "audio" || mediaKind === "image" || mediaKind === "video"
    ? LIVE_MEDIA_SPECS[mediaKind]
    : undefined;
}

/**
 * Download the media, write it under <dataDir>/media/live, and set
 * media_path/media_status on `normalized` — 'present' on success, 'missing' on
 * failure (logged). Returns the video thumbnail-fallback path when the download
 * failed and the kind's onDownloadFailure hook persisted one, else null.
 */
async function downloadAndPersistMedia(args: {
  spec: LiveMediaSpec;
  downloader: (m: WAMessage) => Promise<Buffer>;
  waMessage: WAMessage;
  mapped: MappedMessage;
  mediaFilename: string;
  normalized: NormalizedMessage;
  opts: CollectorOptions;
}): Promise<string | null> {
  const { spec, downloader, waMessage, mapped, mediaFilename, normalized, opts } = args;
  const mediaDir = path.join(opts.dataDir, "media", "live");
  try {
    const buf = await downloader(waMessage);
    fs.mkdirSync(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, mediaFilename);
    fs.writeFileSync(filePath, buf);
    normalized.mediaPath = filePath;
    normalized.mediaStatus = "present";
    return null;
  } catch (err) {
    logDownloadFailure(opts.log, spec.logLabel, mapped.externalId, err);
    normalized.mediaPath = null;
    normalized.mediaStatus = "missing";
    return spec.onDownloadFailure ? spec.onDownloadFailure({ mapped, mediaDir, opts }) : null;
  }
}

/**
 * Handle a single incoming Baileys WAMessage:
 * 1. Map the Baileys message → our domain shape (returns null → ignore).
 * 2. Upsert the group by JID.
 * 3. Upsert the participant.
 * 4. Normalize (source='live', externalId set).
 * 5. Insert into DB (ON CONFLICT dedupe_key → DO NOTHING).
 *
 * Returns true if a new row was stored, false if it was a duplicate or ignored.
 */
export async function handleIncomingMessage(
  client: pg.Pool | pg.PoolClient,
  waMessage: WAMessage,
  opts: CollectorOptions,
): Promise<boolean> {
  // --- Map ---
  const mapped = mapWaMessage(waMessage);
  if (!mapped) {
    // Message type not supported / should be ignored
    return false;
  }

  // --- Upsert group (identity-canonicalized) ---
  // Route the message into the person's existing chat under either WhatsApp
  // identity (@lid vs @s.whatsapp.net) so LID-migration duplicates can't form.
  // `canonicalJid` is the identity the chat is actually keyed under — use it for
  // the display-name resolution below so we target the right row.
  const sibling = await resolveSiblingJid(client, mapped.remoteJid, mapped.remoteJidAlt, opts);
  const siblingJid = sibling.jid;

  // Persist a NEWLY learned pairing (from the live bridge / alt key) durably so
  // future ingest (incl. worker-only, cold bridge) and the reconcile job can
  // canonicalize without a live session. A sibling already read from the DB map
  // needs no re-write — skip it to avoid per-message write amplification.
  if (siblingJid && sibling.learned) {
    const lid = mapped.remoteJid.endsWith("@lid") ? mapped.remoteJid : siblingJid;
    const pn = mapped.remoteJid.endsWith("@lid") ? siblingJid : mapped.remoteJid;
    if (lid.endsWith("@lid") && pn.endsWith("@s.whatsapp.net")) {
      try {
        await recordLink(client, { lidJid: lid, pnJid: pn, source: "message_alt" });
      } catch (e) {
        opts.log?.warn({ err: e, lid, pn }, "identity-link capture failed");
      }
    }
  }

  const { groupId, canonicalJid } = await upsertGroupByCanonicalJid(client, {
    primaryJid: mapped.remoteJid,
    siblingJid,
    name: mapped.remoteJid, // Use JID as name fallback; can be renamed via CLI later
    source: "live",
  });

  // --- Skip messages we already have (history re-push dedup) ---
  // Resolve the existing row id once (subsumes the old existence check). When
  // found, this is a duplicate: optionally (re)attach the media descriptor so a
  // full re-pull enables deferred download, then short-circuit BEFORE the
  // expensive name resolution / participant upsert / media download / insert.
  const existing = mapped.externalId
    ? await getMessageIdByExternalId(client, groupId, mapped.externalId)
    : null;
  if (existing !== null) {
    // Re-pull of a duplicate: (re)attach the descriptor so deferred download
    // works — but never resurrect a pruned message, and reflect already-present
    // media so the backfill loop doesn't re-download it.
    if (
      opts.persistMediaDescriptor &&
      mapped.messageType === "media" &&
      existing.mediaStatus !== "pruned"
    ) {
      try {
        const descriptor = extractMediaDescriptor(waMessage);
        if (descriptor && ANALYZABLE_MEDIA_KINDS.has(descriptor.mediaKind)) {
          const state = existing.mediaStatus === "present" ? "present" : "pending";
          await opts.persistMediaDescriptor(existing.id, descriptor, state);
        }
      } catch (e) {
        opts.log?.warn(
          { err: e, externalId: mapped.externalId, messageId: existing.id },
          "failed to persist media descriptor (existing row)",
        );
      }
    }
    return false;
  }

  // --- Resolve display name (idempotent: no-op once resolved) ---
  // Gate on "still unresolved" to avoid repeat network calls.
  // Errors are caught and non-fatal — the JID stays as the name.
  try {
    const jid = canonicalJid;
    if (await isDisplayNameUnresolved(client, jid)) {
      if (jid.endsWith("@g.us")) {
        if (opts.groupSubject) {
          try {
            const subj = await opts.groupSubject(jid);
            if (subj && subj.trim()) {
              await updateDisplayName(client, jid, subj.trim());
            }
          } catch (e) {
            opts.log?.warn({ err: e, jid }, "failed to resolve group subject");
          }
        }
      } else {
        // @s.whatsapp.net, @lid, and any other non-@g.us JID:
        // resolve from the message pushName (senderName).
        if (mapped.senderName && mapped.senderName.trim()) {
          await updateDisplayName(client, jid, mapped.senderName.trim());
        }
      }
    }
  } catch (e) {
    // Resolution failure must never break message storage
    opts.log?.warn({ err: e }, "display-name resolution error");
  }

  // --- Upsert participant ---
  // The JID rides along so a message can later be quote-replied with the right
  // author. Live messages carry it; imports don't, hence the optional arg.
  const participantId = await upsertParticipant(client, mapped.senderName, mapped.senderJid);

  // Select the download spec for this message's media kind (audio/image/video).
  // Sticker/document/text have no spec → never downloaded or enqueued. When a
  // downloader is wired for the kind, give the media a deterministic filename up
  // front so the dedupe key is stable across re-deliveries.
  const mediaSpec = liveMediaSpecFor(mapped.mediaKind);
  const downloader = mediaSpec?.downloaderOf(opts);
  const mediaFilename =
    mediaSpec && downloader ? mediaSpec.filenameFor(mapped.externalId) : mapped.mediaFilename;

  // --- Normalize ---
  const importedMsg: ImportedMessage = {
    senderName: mapped.senderName,
    sentAt: mapped.sentAt,
    messageType: mapped.messageType,
    textContent: mapped.textContent ?? "",
    mediaFilename,
    fromMe: mapped.fromMe,
  };

  const [normalized] = normalize([importedMsg], {
    groupId,
    importId: null,
    source: "live",
    externalIds: [mapped.externalId],
  });

  if (!normalized) {
    return false;
  }

  // --- Download + persist media (voice notes / images / videos) ---
  // One routine driven by the kind's spec: sets media_path + media_status to
  // 'present' on success or 'missing' on failure (logged), leaving the row
  // recorded either way. The video kind's onDownloadFailure hook persists the
  // embedded jpegThumbnail as an analyzable fallback and returns its path.
  let videoThumbnailPath: string | null = null;
  if (mediaSpec && downloader) {
    videoThumbnailPath = await downloadAndPersistMedia({
      spec: mediaSpec,
      downloader,
      waMessage,
      mapped,
      mediaFilename: mediaFilename!,
      normalized,
      opts,
    });
  }

  // --- Insert ---
  const result = await insertMessages(client, [{ ...normalized, participantId }]);

  const isNew = result.inserted > 0;

  // --- Persist media descriptor for new media rows (deferred-download support) ---
  // Only store descriptors for kinds the analysis pipeline can handle — stickers
  // and documents are never selected by selectPendingMedia and would sit in
  // 'pending' forever (table-bloat / dead rows).
  if (isNew && opts.persistMediaDescriptor && mapped.messageType === "media") {
    try {
      const messageId = result.ids[0];
      if (messageId !== undefined) {
        const descriptor = extractMediaDescriptor(waMessage);
        if (descriptor && ANALYZABLE_MEDIA_KINDS.has(descriptor.mediaKind)) {
          const state = normalized.mediaStatus === "present" ? "present" : "pending";
          await opts.persistMediaDescriptor(messageId, descriptor, state);
        }
      }
    } catch (e) {
      opts.log?.warn(
        { err: e, externalId: mapped.externalId },
        "failed to persist media descriptor (new row)",
      );
    }
  }

  // --- Resolve analysis gate ---
  // Check once whether this group's chat is selected for analysis. Absent option
  // → treat as included (single-user / legacy / test default). Download/capture
  // is never gated — only the analysis enqueues below are conditional on this.
  const analyze = opts.isGroupIncluded ? await opts.isGroupIncluded(groupId) : true;

  // --- Enqueue the analysis/transcription job for new, eligible media ---
  // One gate per kind (spec.enqueueWhen): voice/image require the media present
  // on disk; video also accepts a persisted thumbnail. No bus/spec, or a chat
  // excluded from analysis → no enqueue. Sticker/document/text have no spec.
  if (isNew && mediaSpec && opts.bus && analyze) {
    const eligible = mediaSpec.enqueueWhen({
      downloaderProvided: downloader !== undefined,
      mediaStatus: normalized.mediaStatus,
      thumbnailPath: videoThumbnailPath,
    });
    if (eligible) {
      const messageId = result.ids[0];
      if (messageId !== undefined) {
        await mediaSpec.enqueueJob(opts.bus, String(messageId));
      }
    }
  }

  return isNew;
}
