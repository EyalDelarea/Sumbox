import type pg from "pg";
import { reconcileIdentities } from "./identity-reconcile.js";

export type ReconcileLoopOpts = {
  pool: pg.Pool;
  intervalMs: number;
  /** Injected timer for testability; defaults to setTimeout. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Called if a whole reconcile tick throws. reconcileIdentities logs its own
   *  success/per-pair details, so the loop only surfaces unexpected tick failures. */
  onError?: (err: unknown) => void;
};

/**
 * Run reconcileIdentities once immediately, then every `intervalMs`. Returns a
 * stop() handle. A thrown tick is reported via onError and never stops the loop.
 */
export function startReconcileLoop(opts: ReconcileLoopOpts): { stop: () => void } {
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    try {
      await reconcileIdentities(opts.pool);
    } catch (err) {
      opts.onError?.(err);
    }
    if (!stopped) timer = setTimer(() => void tick(), opts.intervalMs);
  };

  void tick(); // run once on startup
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
