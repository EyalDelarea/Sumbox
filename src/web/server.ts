import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction } from "../db/transaction.js";
import type { ServerDeps } from "./handlers/context.js";
import { handleData } from "./handlers/data.js";
import { handleGroups } from "./handlers/groups.js";
import { handleMessages } from "./handlers/messages.js";
import { handleScopeCategories } from "./handlers/scope-categories.js";
import { handleScopes } from "./handlers/scopes.js";
import { handleStatus } from "./handlers/status.js";
import { handleSummaries } from "./handlers/summaries.js";
import { handleSummarize } from "./handlers/summarize.js";
import { handleSummaryCommands } from "./handlers/summary-commands.js";
import { handleTotalSummary } from "./handlers/total-summary.js";
import { makeOnboardingRoutes } from "./onboarding-routes.js";

export type { ServerDeps } from "./handlers/context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "public", "index.html");

const SPA_PATHS = new Set(["/"]);

export function createServer(deps: ServerDeps): http.Server {
  const onboardingRoutes = deps.onboarding
    ? makeOnboardingRoutes({ registry: deps.onboarding })
    : null;

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && SPA_PATHS.has(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(INDEX_HTML, "utf8"));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      // Onboarding talks to the session adapter, not the DB pool.
      if (onboardingRoutes && (await onboardingRoutes.handle(req, res, url))) return;
      dispatchApi(url, req, res, {
        ...deps,
        withTx: (fn) => withTransaction(deps.pool, fn),
      });
      return;
    }

    // Generic static asset handler — must come after all /api/* routes
    if (req.method === "GET") {
      void handleStatic(url.pathname, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      process.stderr.write(
        `Error handling ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Internal server error." }));
    });
  });
}

function dispatchApi(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): void {
  if (req.method === "GET" && url.pathname === "/api/groups") {
    handleGroups(res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/summarize") {
    if (blockCrossOrigin(req, res)) return;
    void handleSummarize(url, req, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/total-summary") {
    if (blockCrossOrigin(req, res)) return;
    void handleTotalSummary(url, req, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    void handleStatus(res, deps);
    return;
  }
  if (url.pathname.startsWith("/api/summaries")) {
    // State-changing POST (rating) is CSRF-guarded; the read-only GET list is not.
    if (req.method === "POST" && blockCrossOrigin(req, res)) return;
    void handleSummaries(url, req, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/messages") {
    void handleMessages(url, res, deps);
    return;
  }
  if (url.pathname === "/api/scopes" && (req.method === "GET" || req.method === "PUT")) {
    if (req.method === "PUT" && blockCrossOrigin(req, res)) return;
    void handleScopes(url, req, res, deps);
    return;
  }
  if (url.pathname === "/api/scope-categories" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST" && blockCrossOrigin(req, res)) return;
    void handleScopeCategories(url, req, res, deps);
    return;
  }
  if (url.pathname === "/api/summary-commands" && (req.method === "GET" || req.method === "PUT")) {
    if (req.method === "PUT" && blockCrossOrigin(req, res)) return;
    void handleSummaryCommands(url, req, res, deps);
    return;
  }
  if (url.pathname.startsWith("/api/data/")) {
    if (req.method === "POST" && blockCrossOrigin(req, res)) return;
    void handleData(url, req, res, deps);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}

/**
 * CSRF defense for the state-changing GET endpoints (/api/summarize, /api/total-summary):
 * they advance the read watermark + spend LLM compute, but can't move to POST because the
 * browser consumes them via EventSource (GET only, no custom headers). So validate the
 * request's Origin/Referer against its own host instead.
 *
 * Returns true when the request is cross-origin and must be rejected. A same-origin
 * request passes; a request with NEITHER Origin nor Referer also passes (a same-origin
 * top-level GET navigation often omits both) — but a cross-site trigger leaks either an
 * Origin (fetch/form) or the attacker's Referer (window.open / link navigation), which is
 * exactly what this blocks. Combined with the SameSite=Lax session cookie.
 */
export function isCrossOrigin(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false; // nothing to compare against — don't block
  const candidate = req.headers.origin ?? req.headers.referer;
  if (!candidate) return false; // no Origin/Referer present
  try {
    return new URL(candidate).host !== host;
  } catch {
    return true; // malformed Origin/Referer → treat as cross-origin
  }
}

function blockCrossOrigin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!isCrossOrigin(req)) return false;
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Cross-origin request rejected." }));
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

async function handleStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const publicDir = path.resolve(__dirname, "public");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const resolved = path.resolve(path.join(publicDir, decoded));
  // Block path traversal
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  // Read the file directly rather than stat-then-read: a separate existence
  // check would be a TOCTOU race. A missing file or a directory both throw
  // here (ENOENT / EISDIR) and resolve to 404.
  let data: Buffer;
  try {
    data = fs.readFileSync(resolved);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  // Single-user LAN tool: revalidate every load so a redeploy never serves stale JS/CSS.
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
  res.end(data);
}
