import type http from "node:http";
import { findGroupByName } from "../../db/repositories/groups.js";
import { getMessagesAround, getRecentMessages } from "../../db/repositories/messages.js";
import type { ServerDeps } from "./context.js";

/**
 * GET /api/messages?chat=<name>&aroundId=<id>&limit=<n>
 *
 * Read-only window of messages. With aroundId it centers on a cited message
 * (the Ask / summary source-jump). Without aroundId it returns the most recent
 * window — the "show the full conversation" view from a chat summary. Mirrors
 * handleSummaries' data access (findGroupByName + deps.pool) so it inherits the
 * same tenancy treatment as /api/summaries.
 */
export async function handleMessages(
  url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const chat = url.searchParams.get("chat");
  const aroundRaw = url.searchParams.get("aroundId");
  const aroundId = aroundRaw === null ? Number.NaN : Number.parseInt(aroundRaw, 10);
  // chat is required; aroundId is optional. A present-but-malformed aroundId is
  // still a 400 so callers don't silently get the wrong window.
  if (!chat || (aroundRaw !== null && !Number.isFinite(aroundId))) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing chat, or malformed aroundId." }));
    return;
  }

  let limit = 20;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60) : 20;
  }

  try {
    const grp = await findGroupByName(deps.pool, chat);
    if (!grp) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    const rows =
      aroundRaw !== null
        ? await getMessagesAround(deps.pool, grp.id, aroundId, limit)
        : await getRecentMessages(deps.pool, grp.id, limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        rows.map((m) => ({
          id: m.id,
          sender: m.sender,
          text: m.text,
          sentAt: m.sentAt.toISOString(),
          fromMe: m.fromMe,
        })),
      ),
    );
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load messages." }));
  }
}
