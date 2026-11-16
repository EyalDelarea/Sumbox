/**
 * creds-persistence.ts — keep the collector alive when saving or reading the
 * Baileys auth state fails, without ever overwriting a good link.
 *
 * WHY THIS EXISTS. On 2026-11-15 the live collector died from an unhandled
 * promise rejection: `EPERM: operation not permitted, open
 * .../data/baileys-auth/creds.json`, raised while Baileys saved creds during a
 * run of 408 reconnects. `sock.ev.on("creds.update", saveCreds)` hands an async
 * function to a plain EventEmitter, which drops the returned promise — so a
 * failed write became an unhandledRejection, the crash guard treated it as fatal
 * (it is not a transient media-stream abort), and /סיכום went silent for ~3h.
 *
 * WHAT IT DOES.
 *   - `CredsSaver` is the `creds.update` listener. It never rejects: a failed
 *     save is logged at error level and retried with exponential backoff. Saves
 *     coalesce — Baileys' saveCreds always writes the CURRENT in-memory creds, so
 *     one pending save covers every update that arrived while it waited.
 *   - Only after `maxConsecutiveFailures` failed saves in a row does it call
 *     `onFatal`, so a persistent failure exits loudly instead of leaving a
 *     process that runs but can no longer persist its link (a zombie).
 *   - `readStoredCreds` + `assertLoadedStoredCreds` guard `connect()`. Baileys'
 *     useMultiFileAuthState swallows EVERY read error and falls back to brand-new,
 *     unlinked creds. If creds.json exists but can't be read (the same EPERM),
 *     connecting would hand Baileys fresh creds, and the next creds.update would
 *     write them OVER the real link — a silent de-link. So connect() reads the
 *     file itself first (refusing if it exists but can't be read and parsed), and
 *     then checks that Baileys loaded THAT file rather than fresh creds — the
 *     second check closes the gap where Baileys' own read fails transiently.
 *
 * Nothing here deletes or rewrites auth state on its own: it only ever calls the
 * save function Baileys provides, and refuses to connect rather than start over.
 */

import fs from "node:fs";
import path from "node:path";

// ── Backoff ─────────────────────────────────────────────────────────────────

export type BackoffOptions = { baseMs: number; capMs: number };

/** Exponential backoff: baseMs × 2^(failures−1), capped. `failures` starts at 1. */
export function backoffDelay(failures: number, opts: BackoffOptions): number {
  const exp = Math.max(0, failures - 1);
  return Math.min(opts.capMs, opts.baseMs * 2 ** exp);
}

// ── Creds saver ─────────────────────────────────────────────────────────────

/** The pino methods the saver uses (structured object first, message second). */
export type CredsLog = {
  error: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
};

export type CredsSaverOptions = {
  log: CredsLog;
  /** Called once, after `maxConsecutiveFailures` saves in a row have failed. */
  onFatal: (err: unknown, failures: number) => void;
  /** Default 8: with the default backoff that is ~2 minutes of failing saves. */
  maxConsecutiveFailures?: number;
  /** Default 1s doubling to a 60s cap. */
  backoff?: BackoffOptions;
  /** Injectable timer (tests). Default setTimeout. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  /** Last-resort sink if a log call or onFatal itself throws. Default stderr. */
  lastResort?: (line: string) => void;
};

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;
export const DEFAULT_SAVE_BACKOFF: BackoffOptions = { baseMs: 1_000, capMs: 60_000 };

/**
 * One per CollectorSession — NOT one per connect(). The failure counter has to
 * survive reconnects: the incident ran 408 of them, and a per-connection counter
 * would reset on each one and never reach the fatal threshold.
 */
export class CredsSaver {
  private save: (() => Promise<void>) | null = null;
  private saving = false;
  private dirty = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  private fatalRaised = false;

  private readonly log: CredsLog;
  private readonly onFatal: (err: unknown, failures: number) => void;
  private readonly maxFailures: number;
  private readonly backoff: BackoffOptions;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  private readonly lastResort: (line: string) => void;

  constructor(opts: CredsSaverOptions) {
    this.log = opts.log;
    this.onFatal = opts.onFatal;
    this.maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.backoff = opts.backoff ?? DEFAULT_SAVE_BACKOFF;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.lastResort = opts.lastResort ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /**
   * Point the saver at the current connection's save function. Called on every
   * connect(): each one loads its own creds object from disk, and a pending
   * retry must write the live one. The failure count is deliberately kept.
   *
   * If saves were failing, the previous connection's in-memory creds were ahead
   * of disk and are now gone — the new connection starts from the last saved
   * file. That is the same position as a process restart; say so in the log.
   */
  bind(save: () => Promise<void>): void {
    if (this.save !== null && (this.failures > 0 || this.dirty)) {
      this.safeLog(() =>
        this.log.warn(
          { consecutiveFailures: this.failures },
          "reconnected with unsaved creds updates — continuing from the last saved creds.json",
        ),
      );
    }
    this.save = save;
  }

  /** The `creds.update` listener. Synchronous and never throws or rejects. */
  readonly onUpdate = (): void => {
    if (this.stopped) return;
    this.dirty = true;
    // A save in flight re-runs when it settles; a scheduled retry will pick this
    // update up. Either way, one write covers it.
    if (this.saving || this.retryTimer !== null) return;
    this.run();
  };

  /** Consecutive failed saves since the last success (for logs/tests). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Cancel any pending retry; later updates are ignored. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.dirty || this.failures > 0) {
      this.safeLog(() =>
        this.log.warn(
          { consecutiveFailures: this.failures },
          "session stopped with unsaved creds updates — creds.json keeps the last saved state",
        ),
      );
    }
  }

  private run(): void {
    const save = this.save;
    if (save === null || this.stopped) return;
    this.saving = true;
    this.dirty = false;
    // Promise.resolve().then() also turns a synchronous throw into a rejection,
    // and the trailing .catch means nothing in this chain can become an
    // unhandled rejection — not even a throwing logger or onFatal.
    Promise.resolve()
      .then(save)
      .then(
        () => this.onSaved(),
        (err: unknown) => this.onFailed(err),
      )
      .catch((err: unknown) => {
        this.saving = false;
        try {
          this.lastResort(`[collector] creds saver internal error: ${String(err)}`);
        } catch {
          // nowhere left to report it
        }
      });
  }

  private onSaved(): void {
    this.saving = false;
    const recoveredFrom = this.failures;
    this.failures = 0;
    if (recoveredFrom > 0) {
      this.safeLog(() =>
        this.log.info(
          { failuresBeforeSuccess: recoveredFrom },
          "creds save recovered after failure(s)",
        ),
      );
    }
    if (this.dirty) this.run();
  }

  private onFailed(err: unknown): void {
    this.saving = false;
    this.failures++;
    if (this.stopped) {
      this.safeLog(() =>
        this.log.error(
          { err, consecutiveFailures: this.failures },
          "creds save failed after the session stopped — not retrying",
        ),
      );
      return;
    }
    if (this.failures >= this.maxFailures) {
      this.safeLog(() =>
        this.log.error(
          { err, consecutiveFailures: this.failures, maxConsecutiveFailures: this.maxFailures },
          "creds save failed repeatedly — giving up",
        ),
      );
      if (!this.fatalRaised) {
        this.fatalRaised = true;
        this.onFatal(err, this.failures);
      }
      return;
    }
    const retryInMs = backoffDelay(this.failures, this.backoff);
    this.safeLog(() =>
      this.log.error(
        {
          err,
          consecutiveFailures: this.failures,
          maxConsecutiveFailures: this.maxFailures,
          retryInMs,
        },
        "creds save failed — will retry",
      ),
    );
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.run();
    }, retryInMs);
  }

  /** A throwing logger must not stop the retry/fatal bookkeeping. */
  private safeLog(write: () => void): void {
    try {
      write();
    } catch (err) {
      try {
        this.lastResort(`[collector] creds saver could not log: ${String(err)}`);
      } catch {
        // nowhere left to report it
      }
    }
  }
}

// ── Read guard ──────────────────────────────────────────────────────────────

/** creds.json exists but could not be read, or Baileys did not load it. */
export class CredsUnreadableError extends Error {
  constructor(
    readonly credsPath: string,
    cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `${credsPath} exists but could not be loaded (${why}). Refusing to connect with fresh creds, which would overwrite the WhatsApp link. ` +
        `To recover: fix the file's permissions or restore ${credsPath} from a backup; ` +
        `or, if it is truly lost, re-pair by moving ${path.dirname(credsPath)} aside and scanning the QR again. Nothing was deleted.`,
      { cause },
    );
    this.name = "CredsUnreadableError";
  }
}

/** The one field the load check compares (random per fresh creds, persisted). */
export type StoredCreds = { registrationId?: unknown };

/**
 * Read and parse `<authDir>/creds.json`. Returns null when the file does not
 * exist (a first link). Throws CredsUnreadableError when it exists but can't be
 * read or parsed. See the header for why connecting anyway would overwrite the
 * real link.
 */
export async function readStoredCreds(
  authDir: string,
  readFile: (p: string) => Promise<string> = (p) => fs.promises.readFile(p, "utf-8"),
): Promise<StoredCreds | null> {
  const credsPath = path.join(authDir, "creds.json");
  let raw: string;
  try {
    raw = await readFile(credsPath);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw new CredsUnreadableError(credsPath, err);
  }
  try {
    return JSON.parse(raw) as StoredCreds;
  } catch (err) {
    // Also covers a half-written file caught mid-save: retrying later is right.
    throw new CredsUnreadableError(credsPath, err);
  }
}

/**
 * Throw CredsUnreadableError when creds.json existed but Baileys came back with
 * different creds — i.e. its own read failed and it silently minted fresh ones.
 * `registrationId` is random per fresh creds and persisted with the link, so a
 * mismatch means "not the file on disk".
 */
export function assertLoadedStoredCreds(
  authDir: string,
  stored: StoredCreds | null,
  loaded: StoredCreds,
): void {
  if (stored === null) return;
  if (stored.registrationId !== loaded.registrationId) {
    throw new CredsUnreadableError(
      path.join(authDir, "creds.json"),
      new Error("Baileys loaded fresh creds instead of the stored ones"),
    );
  }
}
