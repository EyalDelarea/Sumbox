/**
 * serial-queue.ts — run Rosey's work for one group strictly one at a time,
 * WITHOUT ever dropping a caller.
 *
 * Not the collector's GroupTurnQueue: that queue drops a caller who arrives while
 * someone is already waiting ("busy") or who waits too long ("stale"). That is
 * right for @Aida — a third question in a burst gets a "busy" reply — but here a
 * dropped turn would be an explicit @Rosey command silently lost. Serializing is
 * what keeps dedup coherent (each item sees the one before it); nothing is lost.
 */

export class GroupSerialQueue {
  readonly #tails = new Map<number, Promise<unknown>>();

  /** Run `fn` after every earlier job for `groupId` has settled. */
  run<T>(groupId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(groupId) ?? Promise.resolve();
    // Chain on settle, not success: one failed job must not wedge the group.
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.#tails.set(groupId, tail);
    void tail.then(() => {
      if (this.#tails.get(groupId) === tail) this.#tails.delete(groupId);
    });
    return next;
  }

  /** Groups with work queued or running (for tests and shutdown). */
  get size(): number {
    return this.#tails.size;
  }
}
