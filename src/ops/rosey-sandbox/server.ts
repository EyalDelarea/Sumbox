/**
 * server.ts — the sandbox's local page and its small JSON API.
 *
 * Bound to 127.0.0.1 only. The page shows chat content, so two more checks:
 *  - the Host header must name this server (127.0.0.1 or localhost on its
 *    port): a DNS-rebinding page elsewhere cannot read the API;
 *  - a POST must be JSON, and if it carries an Origin, that origin must be this
 *    server: another site cannot drive the sandbox from the browser.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { RoseySandbox } from "./session.js";

/** Not 8787 (the app's own web server). */
export const DEFAULT_SANDBOX_PORT = 8788;
const MAX_BODY = 16 * 1024;

export type SandboxServerDeps = {
  sandbox: Pick<RoseySandbox, "state" | "post" | "vote" | "suggestNow" | "setStatus" | "listStyle">;
  /** Re-clone the group from live and restart the engine. */
  reset: () => Promise<void>;
  page: string;
  /** The app's font directory (src/web/public/fonts), served at /fonts/. */
  fontsDir: string;
  port: number;
};

function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object") throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

const int = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error("expected an integer");
  return v;
};
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("expected a string");
  return v;
};

export function createSandboxServer(deps: SandboxServerDeps): http.Server {
  const hosts = allowedHosts(deps.port);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  let resetting: Promise<void> | null = null;

  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    "/api/post": async (b) => ({
      id: await deps.sandbox.post({
        member: int(b.member),
        text: str(b.text),
        quotedId: b.quotedId == null ? null : str(b.quotedId),
      }),
    }),
    "/api/vote": async (b) =>
      deps.sandbox.vote({ pollId: str(b.pollId), member: int(b.member), option: int(b.option) }),
    "/api/suggest": async () => deps.sandbox.suggestNow(),
    "/api/task": async (b) => {
      const status = str(b.status);
      if (status !== "open" && status !== "done" && status !== "dropped") {
        throw new Error("status must be open, done or dropped");
      }
      return deps.sandbox.setStatus(int(b.id), status);
    },
    "/api/style": async (b) => {
      const style = str(b.style);
      if (style !== "text" && style !== "poll") throw new Error("style must be text or poll");
      deps.sandbox.listStyle = style;
    },
    "/api/reset": async () => {
      resetting ??= deps.reset().finally(() => {
        resetting = null;
      });
      await resetting;
    },
  };

  return http.createServer((req, res) => {
    void (async () => {
      if (!hosts.has(req.headers.host ?? "")) return send(res, 421, { error: "wrong host" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET") {
        if (url.pathname === "/") return send(res, 200, deps.page, "text/html");
        if (url.pathname === "/api/state") {
          if (resetting) return send(res, 503, { error: "resetting" });
          return send(res, 200, await deps.sandbox.state());
        }
        const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname);
        if (font) {
          const file = path.join(deps.fontsDir, font[1]!);
          if (!fs.existsSync(file)) return send(res, 404, { error: "not found" });
          res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" });
          return fs.createReadStream(file).pipe(res);
        }
        return send(res, 404, { error: "not found" });
      }
      if (req.method === "POST") {
        const route = routes[url.pathname];
        if (!route) return send(res, 404, { error: "not found" });
        const origin = req.headers.origin;
        if (origin !== undefined && !origins.has(origin)) {
          return send(res, 403, { error: "cross-origin request refused" });
        }
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(res, 415, { error: "expected application/json" });
        }
        if (resetting && url.pathname !== "/api/reset") {
          return send(res, 503, { error: "resetting" });
        }
        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
        try {
          return send(res, 200, { ok: true, result: (await route(body)) ?? null });
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
      }
      return send(res, 405, { error: "method not allowed" });
    })().catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    });
  });
}
