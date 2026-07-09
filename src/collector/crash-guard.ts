/**
 * crash-guard.ts — keep the long-running collector alive when a media-download
 * HTTP stream aborts.
 *
 * Baileys downloads media over undici. When WhatsApp's CDN resets an HTTP/2
 * stream mid-download, undici emits an 'error' on a raw Readable that Baileys
 * does not always have a listener for. An unhandled stream 'error' becomes an
 * `uncaughtException` and kills the whole process — even though the per-message
 * handler in live-service.ts already catches the awaited rejection (the stream
 * 'error' fires out of band, so that `.catch` never sees it).
 *
 * This installs a NARROWLY-scoped uncaughtException / unhandledRejection guard:
 * transient network/stream aborts are logged and swallowed so collection keeps
 * running; anything else is treated as fatal (logged, then process exit) so real
 * logic bugs still crash fast instead of being silently masked.
 */

export type CrashGuardLogger = (line: string) => void;

/** Error codes we treat as transient media-stream aborts (safe to swallow). */
const TRANSIENT_CODES = new Set([
  "ERR_HTTP2_STREAM_ERROR",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** Substrings that identify a transient stream/network abort by message text. */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "terminated",
  "other side closed",
  "nghttp2",
  "stream closed",
  "socket hang up",
];

/**
 * True if `err` looks like a transient media-download stream/network abort that
 * we can safely log-and-ignore (rather than crash on). Checks the error's own
 * code/message and one level of `.cause` (undici wraps the HTTP/2 error there).
 */
export function isTransientStreamError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };

  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && TRANSIENT_CODES.has(code)) return true;

  const causeCode =
    e.cause && typeof e.cause === "object" ? (e.cause as { code?: unknown }).code : undefined;
  if (typeof causeCode === "string" && TRANSIENT_CODES.has(causeCode)) return true;

  const haystack = `${typeof e.message === "string" ? e.message : ""} ${
    e.cause &&
    typeof e.cause === "object" &&
    typeof (e.cause as { message?: unknown }).message === "string"
      ? (e.cause as { message: string }).message
      : ""
  }`.toLowerCase();
  return TRANSIENT_MESSAGE_FRAGMENTS.some((frag) => haystack.includes(frag));
}

export type InstallCrashGuardOptions = {
  /** Where to write guard log lines. Default: stderr. */
  log?: CrashGuardLogger;
  /** Called for a NON-transient fatal error. Default: process.exit(1). Injectable for tests. */
  onFatal?: (err: unknown) => void;
};

let installed = false;

/**
 * Install the media-stream crash guard. Idempotent: a second call is a no-op
 * while a guard is already installed. Returns a teardown that removes the
 * listeners and re-arms install (used by tests).
 */
export function installMediaStreamCrashGuard(opts: InstallCrashGuardOptions = {}): () => void {
  const log: CrashGuardLogger = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const onFatal = opts.onFatal ?? (() => process.exit(1));

  if (installed) return () => {};
  installed = true;

  const describe = (err: unknown): string =>
    err instanceof Error ? (err.stack ?? err.message) : String(err);

  const onUncaught = (err: unknown) => {
    if (isTransientStreamError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[crash-guard] swallowed transient media-stream error (collector continues): ${msg}`);
      return;
    }
    log(`[crash-guard] fatal uncaughtException — exiting: ${describe(err)}`);
    onFatal(err);
  };

  const onUnhandled = (reason: unknown) => {
    if (isTransientStreamError(reason)) {
      const msg = reason instanceof Error ? reason.message : String(reason);
      log(`[crash-guard] swallowed transient media-stream rejection (collector continues): ${msg}`);
      return;
    }
    log(`[crash-guard] fatal unhandledRejection — exiting: ${describe(reason)}`);
    onFatal(reason);
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    installed = false;
  };
}
