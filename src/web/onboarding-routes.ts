import type http from "node:http";
import type { SessionHealth, SessionStatus } from "../collector/session-status.js";
import { sseFrame } from "./sse.js";

/**
 * Web onboarding (scan QR → "connected").
 *
 * The /api/onboarding/* surface is a thin adapter over the collector session: it starts
 * the session, streams QR refreshes over SSE, and reports link status.
 */

/** The slice of the onboarding adapter these routes need. */
export interface OnboardingRegistry {
  start(): Promise<void>;
  snapshot(): SessionHealth;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type OnboardingStatus = "unlinked" | "connecting" | "connected" | "logged-out" | "failed";

export type OnboardingRoutesOptions = { registry: OnboardingRegistry };

/** Collapse the session's fine-grained status into what the onboarding UI needs. */
function toOnboardingStatus(status: SessionStatus | undefined): OnboardingStatus {
  switch (status) {
    case "connected":
      return "connected";
    case "logged-out":
      return "logged-out";
    case "failed":
      return "failed";
    case "connecting":
    case "disconnected":
      return "connecting";
    default:
      return "unlinked";
  }
}

export function makeOnboardingRoutes(opts: OnboardingRoutesOptions) {
  const { registry } = opts;

  const statusOf = (): OnboardingStatus => toOnboardingStatus(registry.snapshot().status);

  /** Handle an /api/onboarding/* request. Returns true when handled. */
  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/api/onboarding/")) return false;

    if (req.method === "GET" && url.pathname === "/api/onboarding/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: statusOf() }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/onboarding/link") {
      // Fire-and-forget: start() supervises its own retries; the QR arrives over SSE.
      void registry.start().catch(() => {});
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "connecting" }));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/onboarding/qr") {
      streamQr(req, res);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/onboarding/progress") {
      streamProgress(req, res);
      return true;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
    return true;
  };

  const streamQr = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(sseFrame(event, data));

    // Serialize sends: QR rendering is async, so a "connected"/"logged-out" event that
    // ends the stream must run AFTER any in-flight QR render — otherwise a fast connect
    // could end the response before the QR frame is written (events delivered in order,
    // never dropped). This makes the stream deterministic regardless of render latency.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (work: () => void | Promise<void>): void => {
      chain = chain.then(work).catch(() => {});
    };

    const onQr = (...args: unknown[]): void => {
      // Render server-side to a data URL so the browser just shows an <img> — no
      // client-side QR library (and no CSP exception) needed.
      enqueue(async () => {
        const dataUrl = await renderQrDataUrl(String(args[0]));
        send("qr", { dataUrl });
      });
    };
    const onConnected = (): void => {
      enqueue(() => {
        send("connected", {});
        cleanup();
        res.end();
      });
    };
    const onLoggedOut = (): void => {
      enqueue(() => {
        send("logged-out", {});
        cleanup();
        res.end();
      });
    };
    const cleanup = (): void => {
      registry.off("qr", onQr);
      registry.off("connected", onConnected);
      registry.off("logged-out", onLoggedOut);
    };

    registry.on("qr", onQr);
    registry.on("connected", onConnected);
    registry.on("logged-out", onLoggedOut);
    req.on("close", () => {
      cleanup();
    });

    // Opening the onboarding pane should produce a QR even on first visit, so kick the
    // session off if nothing is in flight yet. start() is idempotent while a session exists.
    const current = registry.snapshot().status;
    if (current !== "connecting" && current !== "connected") {
      void registry.start().catch(() => {});
    }
  };

  /**
   * S5 — stream WhatsApp's history-sync progress (0–100) after the link connects, so
   * the onboarding pane can show a live "scanning your chats" ring. Each forwarded
   * `history-progress` becomes a `progress` frame; reaching 100 emits a terminal
   * `done` frame and ends the stream.
   */
  const streamProgress = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(sseFrame(event, data));

    const onProgress = (...args: unknown[]): void => {
      const info = args[0] as { progress?: number | null; count?: number } | undefined;
      const progress = info?.progress ?? null;
      send("progress", { progress, count: info?.count ?? 0 });
      // WhatsApp reports 100 on the final chunk; treat that as completion.
      if (progress != null && progress >= 100) {
        send("done", {});
        cleanup();
        res.end();
      }
    };
    const cleanup = (): void => {
      registry.off("history-progress", onProgress);
    };

    registry.on("history-progress", onProgress);
    req.on("close", cleanup);
  };

  return { handle, statusOf };
}

/** Encode a WhatsApp linking string to a PNG data URL via the `qrcode` dep (CommonJS). */
async function renderQrDataUrl(qr: string): Promise<string> {
  type QrToDataURL = (text: string, opts?: Record<string, unknown>) => Promise<string>;
  const specifier = "qrcode" as string;
  const mod = (await import(specifier)) as {
    toDataURL?: QrToDataURL;
    default?: { toDataURL?: QrToDataURL };
  };
  const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
  if (!toDataURL) throw new Error("qrcode.toDataURL unavailable");
  return toDataURL(qr, { margin: 1, width: 264 });
}
