/**
 * outbound-guard.ts — a hard safety guardrail that keeps the live WhatsApp
 * collector a PASSIVE observer everywhere except the groups the user enabled.
 *
 * By default (allowSend = false) the tool never emits read receipts, presence or
 * typing, and sends chat messages (including reactions) ONLY to allowlisted
 * groups: the `/סיכום` replies and `@Aida` answers. This guard neutralizes the
 * Baileys socket's high-level outbound methods so even buggy or future code
 * cannot send anywhere else.
 *
 * - HARD_BLOCKED methods (actively send chat content) are replaced with a
 *   function that THROWS unless the target JID is allowlisted — these are only
 *   ever called by application code, so a loud failure is correct and safe.
 * - SILENCED methods (presence / read receipts) are replaced with no-ops, so
 *   that if anything (our code or a library path) calls them, no signal leaves
 *   the device and nothing crashes the receive loop.
 *
 * Low-level transport/keepalive frames that Baileys needs to stay connected are
 * NOT touched (they are not these high-level methods); the device still behaves
 * like any normal linked device at the protocol layer, and its only
 * account-visible activity is what it posts into enabled groups.
 *
 * Lifting the guard for every chat takes an explicit opt-in
 * (WHATSAPP_ALLOW_SEND=true → config.whatsapp.allowSend), never a default.
 */

/**
 * Where the guard reads its allowed JIDs from. A plain Set is a fixed allowlist.
 * A function is re-resolved on **every** send, so a group enabled (or disabled)
 * in the UI takes effect on the next message with no restart — production passes
 * the same DB resolver the `/סיכום` matcher uses, so guard and matcher can never
 * disagree about who is enabled.
 */
export type AllowlistSource =
  | ReadonlySet<string>
  | (() => ReadonlySet<string> | Promise<ReadonlySet<string>>);

/**
 * The startup banner both collector entry points (`serve --collect`, `collect`) log
 * when sending is not globally enabled. It must describe what this guard actually
 * lets through: the allowlisted groups below receive `/סיכום` replies, `@Aida`
 * answers, error replies and ⏳ ⏸ ✅ ❌ status reactions. Shown verbatim in
 * README § Linking WhatsApp.
 */
export const PASSIVE_MODE_BANNER =
  "🔒 Passive mode: no read receipts, presence, or typing. Messages and reactions go ONLY to groups enabled in the commands tab (/סיכום replies, @Aida answers, error replies, and ⏳ ⏸ ✅ ❌ reactions); toggling a group takes effect on its next message, no restart. Every other chat: nothing is sent (WHATSAPP_ALLOW_SEND=true lifts this for every chat).";

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
 *
 * Pass a function (see AllowlistSource) to have the set re-read per send. It is
 * resolved lazily — only once a send is actually attempted — so ordinary traffic
 * never pays for it, and a resolver that throws BLOCKS the send: the guard must
 * prove a JID is enabled before letting anything out.
 */
export function applyOutboundGuard<T>(
  sock: T,
  allowSend: boolean,
  allowlist: AllowlistSource = new Set<string>(),
): T {
  if (allowSend) return sock;

  const target = sock as unknown as Record<string, unknown>;

  const isAllowed = async (jid: unknown): Promise<boolean> => {
    if (typeof jid !== "string") return false;
    const enabled = typeof allowlist === "function" ? await allowlist() : allowlist;
    return enabled.has(jid);
  };

  for (const method of HARD_BLOCKED) {
    if (typeof target[method] === "function") {
      const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
      target[method] = async (...args: unknown[]): Promise<unknown> => {
        if (await isAllowed(args[0])) {
          return original(...args);
        }
        throw new Error(
          `Outbound WhatsApp send blocked: "${method}" targets a chat that is not enabled ` +
            `in the commands tab. Only enabled groups receive /סיכום and @Aida replies.`,
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
