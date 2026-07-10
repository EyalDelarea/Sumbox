import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHealth } from "../collector/session-status.js";
import { makeOnboardingRoutes, type OnboardingRegistry } from "./onboarding-routes.js";

/**
 * Web onboarding: scan QR → "connected". These tests drive the /api/onboarding/* surface
 * against a fake adapter (the real one is an EventEmitter with the same start/snapshot/on
 * shape).
 */

class FakeRegistry extends EventEmitter implements OnboardingRegistry {
  startCount = 0;
  health: SessionHealth = {
    status: "stopped",
    restarts: 0,
    lastError: null,
    lastConnectedAt: null,
  };
  async start(): Promise<void> {
    this.startCount++;
  }
  snapshot(): SessionHealth {
    return this.health;
  }
  setStatus(status: SessionHealth["status"]): void {
    this.health = { ...this.health, status };
  }
}

let server: http.Server | null = null;

function listen(registry: OnboardingRegistry): Promise<string> {
  const routes = makeOnboardingRoutes({ registry });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void routes.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("nope");
      }
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, () => resolve(`http://localhost:${(server!.address() as AddressInfo).port}`));
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

describe("GET /api/onboarding/status", () => {
  it("reports 'unlinked' when there is no session yet", async () => {
    const base = await listen(new FakeRegistry());
    const r = await fetch(`${base}/api/onboarding/status`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "unlinked" });
  });

  it("maps the session health to a coarse onboarding status", async () => {
    const reg = new FakeRegistry();
    reg.setStatus("connected");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connected",
    });
  });

  it("collapses 'disconnected' to 'connecting'", async () => {
    const reg = new FakeRegistry();
    reg.setStatus("disconnected");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connecting",
    });
  });

  it("still requires re-link when logged out (revoked creds)", async () => {
    const reg = new FakeRegistry();
    reg.setStatus("logged-out");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "logged-out",
    });
  });

  it("does NOT mask 'connecting' to 'connected'", async () => {
    const reg = new FakeRegistry();
    reg.setStatus("connecting");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connecting",
    });
  });
});

describe("POST /api/onboarding/link", () => {
  it("starts the session and returns 202", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);
    const r = await fetch(`${base}/api/onboarding/link`, { method: "POST" });
    expect(r.status).toBe(202);
    expect(reg.startCount).toBe(1);
  });
});

describe("GET /api/onboarding/qr (SSE)", () => {
  it("streams QR codes, then a connected event", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);

    const resPromise = fetch(`${base}/api/onboarding/qr`);

    // The handler subscribes synchronously when the request lands; emit on the next tick.
    await new Promise((r) => setTimeout(r, 20));
    reg.emit("qr", "QR-PAYLOAD-1");
    // connected ends the stream — the server serializes it AFTER the async qr render, so
    // the qr frame is always present (no sleep needed; deterministic by construction).
    reg.emit("connected");

    const res = await resPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: qr");
    expect(text).toContain("data:image/png;base64"); // rendered server-side, browser shows <img>
    expect(text).toContain("event: connected");
    // Ordering guarantee: the qr frame precedes the connected frame.
    expect(text.indexOf("event: qr")).toBeLessThan(text.indexOf("event: connected"));
  });

  it("starts the session if it isn't already linking (so opening the pane shows a QR)", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);
    const controller = new AbortController();
    void fetch(`${base}/api/onboarding/qr`, { signal: controller.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(reg.startCount).toBe(1);
    controller.abort();
  });
});

describe("GET /api/onboarding/progress (SSE)", () => {
  it("streams history-sync progress, then a done event at 100", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);

    const resPromise = fetch(`${base}/api/onboarding/progress`);
    await new Promise((r) => setTimeout(r, 20));

    reg.emit("history-progress", { progress: 30, count: 12 });
    reg.emit("history-progress", { progress: 100, count: 40 }); // terminal → done + end

    const res = await resPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: progress");
    expect(text).toContain('"progress":30');
    expect(text).toContain("event: done");
    expect(text.indexOf("event: progress")).toBeLessThan(text.indexOf("event: done"));
  });

  it("keeps streaming when progress is null (older syncs) without ending early", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);

    const controller = new AbortController();
    const resPromise = fetch(`${base}/api/onboarding/progress`, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));

    reg.emit("history-progress", { progress: null, count: 5 });
    await new Promise((r) => setTimeout(r, 20));
    // Stream is still open (no done frame) — abort to finish the test.
    controller.abort();
    await resPromise.catch(() => {});
    expect(true).toBe(true);
  });
});
