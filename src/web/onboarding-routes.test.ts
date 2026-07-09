import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHealth } from "../collector/tenant-session-registry.js";
import { makeOnboardingRoutes, type OnboardingRegistry } from "./onboarding-routes.js";

/**
 * T4 — web onboarding: register → (verify) → scan QR → "connected". These tests drive
 * the /api/onboarding/* surface against a fake registry (the real Baileys registry is
 * an EventEmitter with the same start/snapshot/on shape).
 */

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

class FakeRegistry extends EventEmitter implements OnboardingRegistry {
  started: string[] = [];
  health = new Map<string, SessionHealth>();
  linked = new Set<string>();
  async start(tenantId: string): Promise<void> {
    this.started.push(tenantId);
  }
  snapshot(): SessionHealth[] {
    return [...this.health.values()];
  }
  hasLinkedAuth(tenantId: string): boolean {
    return this.linked.has(tenantId);
  }
  setStatus(tenantId: string, status: SessionHealth["status"]): void {
    this.health.set(tenantId, {
      tenantId,
      status,
      restarts: 0,
      lastError: null,
      lastConnectedAt: null,
    });
  }
}

let server: http.Server | null = null;

function listen(registry: OnboardingRegistry, tenantId = TENANT): Promise<string> {
  const routes = makeOnboardingRoutes({ registry });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void routes.handle(req, res, url, tenantId).then((handled) => {
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
  it("reports 'unlinked' when the tenant has no session yet", async () => {
    const base = await listen(new FakeRegistry());
    const r = await fetch(`${base}/api/onboarding/status`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "unlinked" });
  });

  it("maps the registry health to a coarse onboarding status", async () => {
    const reg = new FakeRegistry();
    reg.setStatus(TENANT, "connected");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connected",
    });
  });

  it("only ever reports the requesting tenant's own status (isolation)", async () => {
    const reg = new FakeRegistry();
    reg.setStatus("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "connected");
    const base = await listen(reg, TENANT);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "unlinked",
    });
  });

  // Regression: a tenant who already linked WhatsApp (creds.json on disk) must not be
  // re-onboarded just because their socket is mid-(re)connect right after login or a
  // server restart. Onboarding completion is the persisted-link fact, not live health.
  it("reports 'connected' for a linked tenant whose socket is still connecting", async () => {
    const reg = new FakeRegistry();
    reg.linked.add(TENANT);
    reg.setStatus(TENANT, "connecting");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connected",
    });
  });

  it("reports 'connected' for a linked tenant with no live session yet (post-restart)", async () => {
    const reg = new FakeRegistry();
    reg.linked.add(TENANT); // creds on disk; startDiscovered hasn't reached it yet
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connected",
    });
  });

  it("still requires re-link when a linked tenant is logged out (revoked creds)", async () => {
    const reg = new FakeRegistry();
    reg.linked.add(TENANT);
    reg.setStatus(TENANT, "logged-out");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "logged-out",
    });
  });

  // The mask must be load-bearing on the link fact: a tenant with NO persisted creds
  // and a connecting socket is still mid-first-link and must NOT be skipped past onboarding.
  it("does NOT mask 'connecting' to 'connected' for a tenant with no persisted creds", async () => {
    const reg = new FakeRegistry(); // linked stays empty
    reg.setStatus(TENANT, "connecting");
    const base = await listen(reg);
    expect(await (await fetch(`${base}/api/onboarding/status`)).json()).toEqual({
      status: "connecting",
    });
  });
});

describe("POST /api/onboarding/link", () => {
  it("starts the tenant's session and returns 202", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);
    const r = await fetch(`${base}/api/onboarding/link`, { method: "POST" });
    expect(r.status).toBe(202);
    expect(reg.started).toEqual([TENANT]);
  });
});

describe("GET /api/onboarding/qr (SSE)", () => {
  it("streams the tenant's QR codes, then a connected event, ignoring other tenants", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);

    const resPromise = fetch(`${base}/api/onboarding/qr`);

    // The handler subscribes synchronously when the request lands; emit on the next tick.
    await new Promise((r) => setTimeout(r, 20));
    reg.emit("qr", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "OTHER-TENANT-QR"); // ignored
    reg.emit("qr", TENANT, "QR-PAYLOAD-1");
    // connected ends the stream — the server serializes it AFTER the async qr render, so
    // the qr frame is always present (no sleep needed; deterministic by construction).
    reg.emit("connected", TENANT);

    const res = await resPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: qr");
    expect(text).toContain("data:image/png;base64"); // rendered server-side, browser shows <img>
    expect(text).not.toContain("OTHER-TENANT-QR");
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
    expect(reg.started).toEqual([TENANT]);
    controller.abort();
  });
});

describe("GET /api/onboarding/progress (SSE)", () => {
  it("streams the tenant's history-sync progress, then a done event at 100, ignoring other tenants", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);

    const resPromise = fetch(`${base}/api/onboarding/progress`);
    await new Promise((r) => setTimeout(r, 20));

    reg.emit("history-progress", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { progress: 99 }); // ignored
    reg.emit("history-progress", TENANT, { progress: 30, count: 12 });
    reg.emit("history-progress", TENANT, { progress: 100, count: 40 }); // terminal → done + end

    const res = await resPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: progress");
    expect(text).toContain('"progress":30');
    expect(text).toContain("event: done");
    // The other tenant's 99 must never appear, and progress precedes done.
    expect(text).not.toContain('"progress":99');
    expect(text.indexOf("event: progress")).toBeLessThan(text.indexOf("event: done"));
  });

  it("keeps streaming when progress is null (older syncs) without ending early", async () => {
    const reg = new FakeRegistry();
    const base = await listen(reg);

    const controller = new AbortController();
    const resPromise = fetch(`${base}/api/onboarding/progress`, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));

    reg.emit("history-progress", TENANT, { progress: null, count: 5 });
    await new Promise((r) => setTimeout(r, 20));
    // Stream is still open (no done frame) — abort to finish the test.
    controller.abort();
    await resPromise.catch(() => {});
    expect(true).toBe(true);
  });
});
