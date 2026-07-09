/**
 * Display-safe sender labels.
 *
 * A participant's `display_name` can be a raw JID when no pushName/contact name
 * was ever delivered — common for history-synced messages. `mapWaMessage` falls
 * back `pushName ?? key.participant ?? remoteJid`, so an unresolved sender ends up
 * stored as a raw `@s.whatsapp.net` / `@lid` JID, or — when even `key.participant`
 * is absent — the chat's own `@g.us` GROUP jid (a group is never a real sender).
 * Surfacing that raw JID as a person is the bug this guards: never show a JID as a
 * name. The phone JID still carries the one identifying fact we have (the number),
 * so we keep it; everything else collapses to a single "unknown" label.
 */

export const UNKNOWN_SENDER = "משתתף לא ידוע";

/** Turn a stored sender (possibly a raw JID) into something safe to show a human. */
export function humanizeSender(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  if (!t) return UNKNOWN_SENDER;
  if (!t.includes("@")) return t; // already a real name (pushName / contact)
  // A phone JID is the sender's actual number — the only id we have, so surface it.
  // (Legacy group jids look like `<phone>-<ts>@g.us`; the leading digits are the
  // group creator, NOT the sender, so we match ONLY a bare `<digits>@s.whatsapp.net`.)
  const phone = t.match(/^(\d{7,15})@s\.whatsapp\.net$/);
  if (phone) return `+${phone[1]}`;
  return UNKNOWN_SENDER; // @g.us (a group), @lid, or any other raw identity
}

/**
 * Optional display-name overrides. WhatsApp only hands us the Latin push name
 * (e.g. "Dana Cohen"), so a Hebrew summary transliterates it — badly ("עיאל"
 * instead of "אייל"). NAME_ALIASES lets the operator pin the exact rendering.
 * Format: `Stored Name=Preferred,Other Name=Preferred` (matched on the raw,
 * trimmed stored display_name — so you can also remap a leaked JID to a person).
 */
export function parseNameAliases(raw: string | undefined | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key && val) map.set(key, val);
  }
  return map;
}

let aliasCache: Map<string, string> | null = null;
function envAliases(): Map<string, string> {
  if (!aliasCache) aliasCache = parseNameAliases(process.env.NAME_ALIASES);
  return aliasCache;
}

/**
 * Resolve a stored sender into its display label: apply an operator alias to the
 * raw name first (so an exact stored name — or a leaked JID — can be remapped),
 * then fall back to {@link humanizeSender}. This is the single label used when
 * feeding sender names to the summarizer. `aliases` is injectable for tests.
 */
export function resolveSenderName(
  name: string | null | undefined,
  aliases: Map<string, string> = envAliases(),
): string {
  const aliased = aliases.get((name ?? "").trim());
  return aliased ?? humanizeSender(name);
}
