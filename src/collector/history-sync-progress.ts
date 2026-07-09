/**
 * history-sync-progress.ts — collapse the noisy per-batch history-sync logging
 * into a single throttled progress line plus one completion summary.
 *
 * On (re)connect WhatsApp delivers its recent-history backfill as many small
 * `messaging-history.set` batches. Logging each batch floods the terminal (and
 * the dev.sh log pipe prefixes every line, so a true `\r` progress bar can't
 * render). Instead we keep a running total, emit a throttled "syncing… N
 * received" line at most once per `throttleMs`, and emit a final "sync complete:
 * N received" once batches stop arriving for `idleMs`.
 *
 * Pure and fully testable: the clock and timer are injectable.
 */

export type ProgressLogger = (line: string) => void;

export type ProgressTimer = { cancel(): void };
export type SetProgressTimer = (fn: () => void, ms: number) => ProgressTimer;

export type HistorySyncProgressOptions = {
  log: ProgressLogger;
  /** Minimum ms between throttled "syncing…" lines. Default 1000. */
  throttleMs?: number;
  /** Quiet period after the last batch before the completion summary fires. Default 3000. */
  idleMs?: number;
  /** Injectable clock. Default Date.now. */
  now?: () => number;
  /** Injectable timer. Default setTimeout (unref'd so it never holds the process open). */
  setTimer?: SetProgressTimer;
};

export type HistorySyncProgress = {
  /** Record a delivered history batch of `count` messages. */
  record(count: number): void;
};

const defaultSetTimer: SetProgressTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  // Don't let a pending summary timer keep the process alive on shutdown.
  (handle as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export function createHistorySyncProgress(opts: HistorySyncProgressOptions): HistorySyncProgress {
  const { log } = opts;
  const throttleMs = opts.throttleMs ?? 1000;
  const idleMs = opts.idleMs ?? 3000;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultSetTimer;

  let total = 0;
  let batches = 0;
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let idleTimer: ProgressTimer | null = null;

  const fmt = (n: number) => n.toLocaleString("en-US");

  const reset = () => {
    total = 0;
    batches = 0;
    lastLoggedAt = Number.NEGATIVE_INFINITY;
    idleTimer = null;
  };

  const emitComplete = () => {
    log(`sync complete: ${fmt(total)} message(s) received across ${fmt(batches)} batch(es)`);
    reset();
  };

  return {
    record(count: number) {
      if (count <= 0) return;
      total += count;
      batches += 1;

      const t = now();
      if (t - lastLoggedAt >= throttleMs) {
        lastLoggedAt = t;
        log(`syncing… ${fmt(total)} message(s) received`);
      }

      // (Re)arm the idle timer — the summary fires once batches go quiet.
      idleTimer?.cancel();
      idleTimer = setTimer(emitComplete, idleMs);
    },
  };
}
