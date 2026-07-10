import fsp from "node:fs/promises";
import pg from "pg";
import { loadConfig } from "../config.js";
import { participantNamesForBiasing } from "../db/repositories/participants.js";
import {
  countTranscribedVoiceNotes,
  getVoiceNoteMediaPath,
  insertTranscript,
  selectPendingVoiceNotes,
} from "../db/repositories/transcripts.js";
import { convertToWav, IvritWhisperTranscriber } from "./ivrit-whisper.js";
import type { Transcriber } from "./transcriber.js";

/**
 * Comma-joined participant-name bias for the chat a voice note belongs to, or
 * undefined when the chat has no usable names (→ an un-biased decode).
 */
async function hotwordsFor(
  pool: pg.Pool | pg.PoolClient,
  messageId: number | string,
): Promise<string | undefined> {
  // ponytail: one small indexed query per voice note — fine at voice-note
  // volume; memoize per group if a batch ever transcribes thousands at once.
  try {
    const names = await participantNamesForBiasing(pool, messageId);
    return names.length ? names.join(", ") : undefined;
  } catch {
    // Hotwording is a best-effort soft bias — a roster lookup failure must
    // degrade to an un-biased decode, never fail the transcription itself.
    return undefined;
  }
}

/** A voice note ready to transcribe: its DB id and the on-disk media path. */
export type NoteToTranscribe = { messageId: number; mediaPath: string };

/** Engine + conversion knobs shared by the single-shot and batch callers. */
export type TranscribeCoreDeps = {
  transcriber: Transcriber;
  engine: string;
  ffmpegPath: string;
  /** When true, convert the media to WAV via ffmpeg before decoding. */
  convert: boolean;
};

/**
 * The shared per-note transcription body: (optionally convert to WAV) →
 * hotword-bias → transcribe → insertTranscript("completed"); on any error,
 * insertTranscript("failed") with the message; the wav temp file is always
 * unlinked in a finally. transcriber.open()/close() are the caller's job (the
 * single-shot path opens per note; the batch opens once around the whole loop).
 *
 * The two callers diverge only at the edges, so those are injected:
 *  - onSuccess(): after the completed row — the single-shot path prunes the
 *    media file; the batch loop just counts.
 *  - onFailure(err): after the failed row — the single-shot path rethrows so the
 *    bus retries; the batch loop swallows and counts.
 * onSuccess runs inside the try (matching the original prune placement), so a
 * throw there still routes through onFailure.
 */
export async function transcribeNoteCore(
  pool: pg.Pool,
  note: NoteToTranscribe,
  deps: TranscribeCoreDeps,
  handlers: {
    onSuccess: () => void | Promise<void>;
    onFailure: (err: unknown) => void | Promise<void>;
  },
): Promise<void> {
  let wavPath: string | null = null;
  try {
    const audioPath = deps.convert
      ? (wavPath = await convertToWav(deps.ffmpegPath, note.mediaPath))
      : note.mediaPath;
    const { text } = await deps.transcriber.transcribe(
      audioPath,
      await hotwordsFor(pool, note.messageId),
    );
    await insertTranscript(pool, {
      messageId: note.messageId,
      transcript: text,
      engine: deps.engine,
      status: "completed",
    });
    await handlers.onSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertTranscript(pool, {
      messageId: note.messageId,
      transcript: null,
      engine: deps.engine,
      status: "failed",
      errorMessage: message,
    });
    await handlers.onFailure(err);
  } finally {
    if (wavPath) {
      await fsp.unlink(wavPath).catch(() => {});
    }
  }
}

export type TranscribeOneNoteDeps = {
  /**
   * Injected pool (T2: the worker passes its tenant-scoped app pool so transcript
   * reads/writes are RLS-attributed). When absent, a private pool is opened from
   * databaseUrl and closed on completion — the original CLI behavior.
   */
  pool?: pg.Pool;
  databaseUrl: string;
  transcriber: Transcriber;
  engine: string;
  ffmpegPath: string;
  convert: boolean;
  /**
   * When true, keep the voice-note file on disk after a successful transcription.
   * Default false (prune after caption).
   */
  retainMedia: boolean;
  /**
   * Called after a successful transcription to delete the on-disk media file.
   * Injected so tests can verify it is called without real FS operations.
   * Production wires pruneMediaFile from src/media/prune.ts (partially applied).
   */
  pruneMediaFile: (messageId: string) => Promise<void>;
};

/**
 * Transcribe a single voice note identified by messageId and persist the
 * transcript. This is the single-note building block used by the
 * `transcribe.voicenote` worker handler (US2).
 *
 * Throws if the message is not found / not a voice note on disk (caller logs
 * and may retry), or if the transcription engine fails (bus retries).
 *
 * Does NOT check for an existing transcript — that check is the handler's
 * responsibility for idempotency.
 */
export async function transcribeOneNote(
  messageId: string,
  deps: TranscribeOneNoteDeps,
): Promise<void> {
  const ownsPool = deps.pool === undefined;
  const pool = deps.pool ?? new pg.Pool({ connectionString: deps.databaseUrl });
  try {
    const mediaPath = await getVoiceNoteMediaPath(pool, messageId);
    if (!mediaPath) {
      throw new Error(
        `transcribeOneNote: message ${messageId} not found or not a present voice note`,
      );
    }

    await deps.transcriber.open();
    try {
      await transcribeNoteCore(
        pool,
        { messageId: Number(messageId), mediaPath },
        {
          transcriber: deps.transcriber,
          engine: deps.engine,
          ffmpegPath: deps.ffmpegPath,
          convert: deps.convert,
        },
        {
          // Prune the media file after a successful transcription (gated by retainMedia).
          onSuccess: async () => {
            if (!deps.retainMedia) {
              await deps.pruneMediaFile(messageId);
            }
          },
          // Re-throw so the handler (and bus) knows it failed → retry.
          onFailure: (err) => {
            throw err;
          },
        },
      );
    } finally {
      await deps.transcriber.close();
    }
  } finally {
    if (ownsPool) await pool.end();
  }
}

export type RunTranscriptionInput = {
  /** Only transcribe voice notes in this group; undefined = all groups. */
  groupName?: string;
};

export type RunTranscriptionResult = {
  ok: number;
  failed: number;
  skipped: number;
};

type RunTranscriptionDeps = {
  databaseUrl: string;
  /** Inject a Transcriber (tests). Defaults to IvritWhisperTranscriber from config. */
  transcriber: Transcriber;
  /** Engine label recorded on each row. Defaults to the configured model. */
  engine: string;
  /** ffmpeg path. Defaults to config. */
  ffmpegPath: string;
  /** When true, convert each file to WAV via ffmpeg before transcribing.
   *  Defaults to true for a real run; tests inject a stub and skip conversion. */
  convert: boolean;
};

export async function runTranscription(
  input: RunTranscriptionInput,
  deps?: Partial<RunTranscriptionDeps>,
): Promise<RunTranscriptionResult> {
  const config = loadConfig();
  const databaseUrl = deps?.databaseUrl ?? config.databaseUrl;
  const engine = deps?.engine ?? config.transcription.model;
  const ffmpegPath = deps?.ffmpegPath ?? config.transcription.ffmpegPath;
  // A real run converts to WAV; an injected stub skips conversion by default.
  const convert = deps?.convert ?? deps?.transcriber === undefined;

  const transcriber: Transcriber =
    deps?.transcriber ??
    new IvritWhisperTranscriber({
      pythonPath: config.transcription.pythonPath,
      model: config.transcription.model,
      ffmpegPath,
    });

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const skipped = await countTranscribedVoiceNotes(pool, input.groupName);
    const pending = await selectPendingVoiceNotes(pool, input.groupName);

    if (pending.length === 0) {
      return { ok: 0, failed: 0, skipped };
    }

    // open() may throw if Python/model/env is not ready — surfaces before any
    // per-file work, so the CLI can report a clear error (FR-023).
    await transcriber.open();

    let ok = 0;
    let failed = 0;

    try {
      for (const note of pending) {
        // The batch counts successes/failures and never prunes or rethrows —
        // a bad note is recorded as failed and the loop moves on (resumable).
        await transcribeNoteCore(
          pool,
          { messageId: note.messageId, mediaPath: note.mediaPath },
          { transcriber, engine, ffmpegPath, convert },
          {
            onSuccess: () => {
              ok++;
            },
            onFailure: () => {
              failed++;
            },
          },
        );
      }
    } finally {
      await transcriber.close();
    }

    return { ok, failed, skipped };
  } finally {
    await pool.end();
  }
}
