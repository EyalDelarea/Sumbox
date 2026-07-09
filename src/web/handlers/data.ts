import type http from "node:http";
import type pg from "pg";
import {
  deleteTenantCompletely,
  purgeUnselectedChats,
  unlinkMediaFiles,
} from "../../db/repositories/data-deletion.js";
import { DEFAULT_TENANT_ID } from "../../db/tenant-context.js";
import type { ServerDeps } from "./context.js";

/**
 * Self-service destructive data endpoints. All POST, CSRF-guarded by dispatchApi, scoped
 * to the request's own tenant — a tenant can only ever wipe their OWN data.
 *
 *  POST /api/data/delete-account    — wipe everything (default tenant stays active).
 *  POST /api/data/purge-unselected  — delete every chat the user did not include.
 *
 * DB work runs inside the request's tenant transaction (deps.withTx) so it is atomic; the
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

/** Run fn inside the request's tenant transaction when available, else directly on the pool. */
function inTx<T>(
  deps: ServerDeps,
  fn: (client: pg.Pool | pg.PoolClient) => Promise<T>,
): Promise<T> {
  return deps.withTx ? deps.withTx(fn) : fn(deps.pool);
}

async function deleteAccount(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const tenantId = deps.tenantId ?? DEFAULT_TENANT_ID;
  // Single-user only: the lone default tenant stays active (never soft-deleted) so the
  // zero-config app keeps working empty after a wipe.
  try {
    const { mediaPaths } = await inTx(deps, (c) =>
      deleteTenantCompletely(c, tenantId, { softDelete: false }),
    );
    const mediaDeleted = await unlinkMediaFiles(mediaPaths);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mediaDeleted }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to delete account." }));
  }
}

async function purgeUnselected(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const tenantId = deps.tenantId ?? DEFAULT_TENANT_ID;
  try {
    const { chatsAffected, mediaPaths } = await inTx(deps, (c) =>
      purgeUnselectedChats(c, tenantId),
    );
    const mediaDeleted = await unlinkMediaFiles(mediaPaths);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, chatsAffected, mediaDeleted }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to purge unselected chats." }));
  }
}
