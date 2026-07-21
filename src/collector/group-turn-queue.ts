/**
 * group-turn-queue.ts — one-deep serial turn-taking, keyed by group.
 *
 * Replaces the bare `Set<number>` in-flight lock shared by ask-command.ts and
 * summary-command.ts. That set answered one question per group and DROPPED every
 * other one: the asker got a ⏸ and nothing else, because the question was never
 * stored anywhere and so had no turn to come back on. Two people talking to her
 * at once meant one of them was silently ignored.
 *
 * Serial, not concurrent, and deliberately so: every answer runs a local Ollama
 * generation, so two at once on one machine make both slower rather than either
 * faster. The queue changes WHEN the second answer runs, not how many run.
 *
 * ── Why one deep ────────────────────────────────────────────────────────────
 * A waiting slot of exactly one bounds the backlog to something the group can
 * predict. Unbounded queueing turns a burst of five questions into five answers
 * arriving long after the conversation moved on; the third-and-beyond caller
 * still gets ⏸ ("heard, resend"), which is the honest signal.
 *
 * ── Why a TTL ───────────────────────────────────────────────────────────────
 * The reason the drop existed in the first place: an answer that fires minutes
 * late is worse than no answer, because the thread has moved. A queued turn that
 * waited past `ttlMs` is therefore abandoned and reported as "stale" so the
 * caller can flip its ⏳ back to ⏸ rather than reply into a dead thread.
 *
 * ── Why the turn is handed off, not re-acquired ─────────────────────────────
 * `release` passes the slot DIRECTLY to the waiter instead of clearing it and
 * letting the waiter race for it. Clearing would let a message arriving in the
 * same tick take the slot ahead of someone who had already been promised a turn
 * — two answers running at once, which is the exact thing the lock exists to
 * prevent.
 */

/** Two minutes — long enough to sit through one local generation, short enough
 *  that the answer still lands in the conversation that asked for it. */
export const DEFAULT_TURN_TTL_MS = 120_000;

/**
 * - `acquired` — the caller holds the turn and MUST call `release` when done.
 * - `busy` — someone is already waiting; this turn is dropped, tell the asker.
 * - `stale` — waited past the TTL; dropped, and the ⏳ already shown is now a
 *   promise the caller has to walk back.
 */
export type TurnOutcome = "acquired" | "busy" | "stale";

export type GroupTurnQueueOptions = {
  /** How long a queued turn may wait before it is abandoned. */
  ttlMs?: number;
  /** Injectable clock, so the TTL is testable without real time. */
  now?: () => number;
};

export class GroupTurnQueue {
  /** groupId → resolvers of the turns waiting behind the current holder.
   *  Presence of the key IS the lock; the array is the (≤1) waiting slot. */
  readonly #holders = new Map<number, Array<() => void>>();
  /** Groups that already have someone waiting, so the next caller is `busy`. */
  readonly #waiting = new Set<number>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: GroupTurnQueueOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TURN_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Take the turn for `groupId`, waiting behind at most one other caller.
   *
   * `onQueued` fires as soon as the caller is known to be waiting — before the
   * wait, not after it — so the asker learns an answer is coming instead of
   * sitting in silence. It is best-effort: a throw is swallowed, because a
   * failed reaction must never cost the turn.
   */
  async take(groupId: number, opts: { onQueued?: () => Promise<void> } = {}): Promise<TurnOutcome> {
    const queuedAt = this.#now();
    const holders = this.#holders.get(groupId);
    if (!holders) {
      this.#holders.set(groupId, []);
      return "acquired";
    }
    if (this.#waiting.has(groupId)) return "busy";

    this.#waiting.add(groupId);
    // Register BEFORE awaiting anything. The Promise executor runs synchronously,
    // so the resolver is in the live array before `onQueued` can yield — awaiting
    // first would let a `release` in that gap find an empty queue and drop the
    // slot, stranding this caller on a promise nobody holds.
    const turn = new Promise<void>((resolve) => holders.push(resolve));
    try {
      await opts.onQueued?.();
    } catch {
      /* the ack is cosmetic; never lose the turn over it */
    }
    await turn;
    this.#waiting.delete(groupId);

    if (this.#now() - queuedAt > this.#ttlMs) {
      // Hand the slot on rather than keeping it: we were promoted, so nobody
      // else will release this group, and returning without doing so would lock
      // it forever.
      this.release(groupId);
      return "stale";
    }
    return "acquired";
  }

  /** Give up the turn, promoting the waiter if there is one. */
  release(groupId: number): void {
    const holders = this.#holders.get(groupId);
    if (!holders) return;
    const next = holders.shift();
    if (next) next();
    else this.#holders.delete(groupId);
  }
}
