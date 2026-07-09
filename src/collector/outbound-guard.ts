/**
 * outbound-guard.ts — a hard safety guardrail that makes the live WhatsApp
 * collector a strictly PASSIVE, read-only observer.
 *
 * By default (allowSend = false) the tool must never transmit anything that is
 * visible on the account: no chat messages, no read receipts, no presence /
 * typing. This guard neutralizes the Baileys socket's high-level outbound
 * methods so even buggy or future code cannot accidentally send.
 *
 * - HARD_BLOCKED methods (actively send chat content) are replaced with a
 *   function that THROWS — these are only ever called by application code, so a
 *   loud failure is correct and safe.
 * - SILENCED methods (presence / read receipts) are replaced with no-ops, so
 *   that if anything (our code or a library path) calls them, no signal leaves
 *   the device and nothing crashes the receive loop.
 *
 * Low-level transport/keepalive frames that Baileys needs to stay connected are
 * NOT touched (they are not these high-level methods); the device still behaves
 * like any normal linked device at the protocol layer, but emits no
 * account-visible activity.
 *
 * Sending can only be enabled by an explicit opt-in (WHATSAPP_ALLOW_SEND=true →
 * config.whatsapp.allowSend), never by default.
 */

/** Methods that actively send chat content — blocked by throwing. */
export const HARD_BLOCKED = ["sendMessage", "relayMessage"] as const;

/** Methods that emit presence / read / receipt signals — silenced to no-ops. */
export const SILENCED = [
  "sendPresenceUpdate",
  "readMessages",
  "sendReceipt",
  "sendReceipts",
  "chatModify",
] as const;

/**
 * Apply the outbound guard to a Baileys socket in place. Returns the same
 * socket for convenience. When `allowSend` is true this is a no-op (the caller
 * has explicitly opted into sending).
 *
 * `allowlist` is a narrow, deliberate exception: JIDs in it may receive sends
 * even while global sending stays blocked. HARD_BLOCKED methods take the target
 * JID as their first argument (`sendMessage(jid, …)`, `relayMessage(jid, …)`),
 * so an allowlisted target calls through to the original; every other JID still
 * throws. Used by the `/סיכום` command-reply feature (allowlist sourced from the
 * DB `group_command_permissions` table, see src/serve/summary-command-deps.ts) to
 * reply into one specific group without lifting the passive-observer net for the
 * rest of the account.
 */
export function applyOutboundGuard<T>(
  sock: T,
  allowSend: boolean,
  allowlist: ReadonlySet<string> = new Set(),
): T {
  if (allowSend) return sock;

  const target = sock as unknown as Record<string, unknown>;

  for (const method of HARD_BLOCKED) {
    if (typeof target[method] === "function") {
      const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
      target[method] = async (...args: unknown[]): Promise<unknown> => {
        const jid = args[0];
        if (typeof jid === "string" && allowlist.has(jid)) {
          return original(...args);
        }
        throw new Error(
          `Outbound WhatsApp send blocked: "${method}" is disabled (read-only mode). ` +
            `Set WHATSAPP_ALLOW_SEND=true to explicitly enable sending.`,
        );
      };
    }
  }

  for (const method of SILENCED) {
    if (typeof target[method] === "function") {
      target[method] = async (): Promise<undefined> => undefined;
    }
  }

  return sock;
}
