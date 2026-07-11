/**
 * group-subject-throttle.ts — bound the WhatsApp `groupMetadata` call rate.
 *
 * A group's display name is resolved lazily: while its stored name is still the
 * raw JID, every incoming message tries to fetch the group subject. That gate
 * only closes once a *usable* name is written, so a group whose fetch keeps
 * throwing (rate-overlimit) or returns an empty subject gets re-queried on every
 * message — and a burst of messages from one group fires many concurrent
 * `groupMetadata` queries, which is exactly what trips WhatsApp's 429
 * (`rate-overlimit`) and turns into a self-reinforcing storm.
 *
 * This throttle sits in front of the fetch and applies two independent guards,
 * keyed per JID:
 *
 *  - **In-flight dedupe** — collapses concurrent lookups for the same JID into a
 *    single underlying query (the burst path: many `void`-fired handlers).
 *  - **Negative cooldown** — after an attempt that yields no usable name (the
 *    fetch throws OR returns an empty subject), suppresses re-queries for a
 *    cooldown window and returns `""` without calling the fetch (the sequential
 *    repeat path: awaited handlers that each settle before the next starts).
 *
 * A *successful* resolution arms no cooldown — the caller writes the real name,
 * which closes the DB gate and stops further lookups anyway. The state is
 * in-memory and self-healing: after the window elapses the JID is retried once,
 * and a restart simply resets the budget. No persistence, no migration.
 */
export class GroupSubjectThrottle {
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly cooldownUntil = new Map<string, number>();

  /**
   * @param cooldownMs How long to suppress re-queries for a JID after an attempt
   *   that yielded no usable name.
   * @param now Injected clock (defaults to `Date.now`) so the cooldown is
   *   testable without real timers.
   */
  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Resolve the subject for `jid` through `fetch`, applying dedupe + cooldown.
   * Returns `""` (without calling `fetch`) while `jid` is cooling down. Never
   * throws: a fetch that throws or returns an empty subject arms the cooldown
   * and resolves to `""`.
   */
  async resolve(jid: string, fetch: (jid: string) => Promise<string>): Promise<string> {
    const until = this.cooldownUntil.get(jid);
    if (until !== undefined && this.now() < until) return "";

    const pending = this.inFlight.get(jid);
    if (pending) return pending;

    const query = this.run(jid, fetch);
    this.inFlight.set(jid, query);
    try {
      return await query;
    } finally {
      this.inFlight.delete(jid);
    }
  }

  private async run(jid: string, fetch: (jid: string) => Promise<string>): Promise<string> {
    let subject = "";
    try {
      subject = (await fetch(jid)).trim();
    } catch {
      subject = "";
    }
    if (!subject) {
      this.cooldownUntil.set(jid, this.now() + this.cooldownMs);
      return "";
    }
    this.cooldownUntil.delete(jid);
    return subject;
  }
}
