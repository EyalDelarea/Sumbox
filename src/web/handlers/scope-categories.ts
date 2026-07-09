import type http from "node:http";
import { createCategory, listCategories } from "../../db/repositories/scope-categories.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

/**
 * GET  /api/scope-categories — the tenant's category list.
 * POST /api/scope-categories — create a user category { name }.
 * POST is CSRF-guarded by dispatchApi before this runs.
 */
export async function handleScopeCategories(
  _url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method === "GET") return getCategories(res, deps);
  if (req.method === "POST") return postCategory(req, res, deps);
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed." }));
}

async function getCategories(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const cats = await listCategories(deps.pool);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(cats));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load categories." }));
  }
}

async function postCategory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = typeof body?.["name"] === "string" ? (body["name"] as string).trim() : "";
  if (!name) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing category name." }));
    return;
  }
  try {
    const created = await createCategory(deps.pool, name);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(created));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to create category." }));
  }
}
