import type http from "node:http";
import type pg from "pg";
import {
  deleteAllData,
  purgeUnselectedChats,
  unlinkMediaFiles,
} from "../../db/repositories/data-deletion.js";
import type { ServerDeps } from "./context.js";

/**
 * Self-service destructive data endpoints. All POST, CSRF-guarded by dispatchApi.
 *
 *  POST /api/data/delete-account    — wipe everything.
 *  POST /api/data/purge-unselected  — delete every chat the user did not include.
 *
 * DB work runs inside the request's transaction (deps.withTx) so it is atomic; the
 * returned media files are unlinked AFTER commit so a rollback never orphans rows.
 */
export async function handleData(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  if (url.pathname === "/api/data/delete-account") return deleteAccount(res, deps);
  if (url.pathname === "/api/data/purge-unselected") return purgeUnselected(res, deps);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found." }));
}

/** Run fn inside the request's transaction when available, else directly on the pool. */
function inTx<T>(
  deps: ServerDeps,
  fn: (client: pg.Pool | pg.PoolClient) => Promise<T>,
): Promise<T> {
  return deps.withTx ? deps.withTx(fn) : fn(deps.pool);
}

async function deleteAccount(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const { mediaPaths } = await inTx(deps, (c) => deleteAllData(c));
    const mediaDeleted = await unlinkMediaFiles(mediaPaths);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mediaDeleted }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to delete account." }));
  }
}

async function purgeUnselected(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const { chatsAffected, mediaPaths } = await inTx(deps, (c) => purgeUnselectedChats(c));
    const mediaDeleted = await unlinkMediaFiles(mediaPaths);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, chatsAffected, mediaDeleted }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to purge unselected chats." }));
  }
}
