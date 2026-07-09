import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";
import type { OnboardingRegistry } from "../web/onboarding-routes.js";
import { makeOnboardingRoutes } from "../web/onboarding-routes.js";
import { composeOnboarding, SingleTenantOnboardingAdapter } from "./single-tenant-onboarding.js";
import type { SessionHealth, TenantSessionStatus } from "./tenant-session-registry.js";

describe("SingleTenantOnboardingAdapter", () => {
  it("starts 'connecting' when no device is linked", () => {
    const a = new SingleTenantOnboardingAdapter({ initiallyLinked: false });
    expect(a.snapshot()).toEqual([
      {
        tenantId: DEFAULT_TENANT_ID,
        status: "connecting",
        restarts: 0,
        lastError: null,
        lastConnectedAt: null,
      },
    ]);
  });

  it("starts 'connected' when a device is already linked (gate skips onboarding)", () => {
    const a = new SingleTenantOnboardingAdapter({ initiallyLinked: true });
    expect(a.snapshot()[0].status).toBe("connected");
  });

  it("re-emits the session's events with the default tenant id", () => {
    const src = new EventEmitter();
    const a = new SingleTenantOnboardingAdapter({ initiallyLinked: false });
    a.attachSession(src);
    const seen: unknown[][] = [];
    a.on("qr", (...args) => seen.push(["qr", ...args]));
    a.on("connected", (...args) => seen.push(["connected", ...args]));
    a.on("history-progress", (...args) => seen.push(["history-progress", ...args]));
    src.emit("qr", "QR-1");
    src.emit("history-progress", { progress: 42, count: 9 });
    src.emit("connected");
    expect(seen).toEqual([
      ["qr", DEFAULT_TENANT_ID, "QR-1"],
      ["history-progress", DEFAULT_TENANT_ID, { progress: 42, count: 9 }],
      ["connected", DEFAULT_TENANT_ID],
    ]);
    expect(a.snapshot()[0].status).toBe("connected");
  });

  it("replays the buffered QR to a late subscriber", () => {
    const src = new EventEmitter();
    const a = new SingleTenantOnboardingAdapter({ initiallyLinked: false });
    a.attachSession(src);
    src.emit("qr", "QR-LATE"); // emitted before anyone subscribes
    const got: unknown[][] = [];
    a.on("qr", (...args) => got.push(args)); // subscribe afterwards
    expect(got).toEqual([[DEFAULT_TENANT_ID, "QR-LATE"]]);
  });

  it("does not replay a stale QR once connected", () => {
    const src = new EventEmitter();
    const a = new SingleTenantOnboardingAdapter({ initiallyLinked: false });
    a.attachSession(src);
    src.emit("qr", "QR-X");
    src.emit("connected");
    const got: unknown[][] = [];
    a.on("qr", (...args) => got.push(args));
    expect(got).toEqual([]);
  });
});

describe("adapter through /api/onboarding/status", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it("serves the adapter's status as the onboarding status", async () => {
    const a = new SingleTenantOnboardingAdapter({ initiallyLinked: true });
    const routes = makeOnboardingRoutes({ registry: a });
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void routes.handle(req, res, url, DEFAULT_TENANT_ID).then((h) => {
        if (!h) {
          res.writeHead(404);
          res.end("nope");
        }
      });
    });
    const base = await new Promise<string>((resolve) =>
      server!.listen(0, () =>
        resolve(`http://localhost:${(server!.address() as AddressInfo).port}`),
      ),
    );
    const r = await fetch(`${base}/api/onboarding/status`);
    expect(await r.json()).toEqual({ status: "connected" });
  });
});

describe("composeOnboarding", () => {
  const OTHER = "11111111-1111-1111-1111-111111111111";
  const health = (tenantId: string, status: TenantSessionStatus): SessionHealth => ({
    tenantId,
    status,
    restarts: 0,
    lastError: null,
    lastConnectedAt: null,
  });
  const fake = (entries: SessionHealth[]) => {
    const started: string[] = [];
    const reg: OnboardingRegistry = {
      start: (t) => {
        started.push(t);
        return Promise.resolve();
      },
      snapshot: () => entries,
      on: () => undefined,
      off: () => undefined,
    };
    return { started, reg };
  };

  it("starts the default tenant on legacy and other tenants on the registry", async () => {
    // The bug this guards: routing DEFAULT to the registry opens a 2nd socket on the
    // shared root creds → WhatsApp 440 reconnect loop. DEFAULT must hit legacy only.
    const legacy = fake([health(DEFAULT_TENANT_ID, "connected")]);
    const registry = fake([health(OTHER, "connecting")]);
    const c = composeOnboarding(legacy.reg, registry.reg);

    await c.start(DEFAULT_TENANT_ID);
    expect(legacy.started).toEqual([DEFAULT_TENANT_ID]);
    expect(registry.started).toEqual([]);

    await c.start(OTHER);
    expect(registry.started).toEqual([OTHER]);
    expect(legacy.started).toEqual([DEFAULT_TENANT_ID]); // unchanged
  });

  it("merges snapshots, keeping legacy's default entry and dropping the registry's", () => {
    const legacy = fake([health(DEFAULT_TENANT_ID, "connected")]);
    const registry = fake([health(DEFAULT_TENANT_ID, "connecting"), health(OTHER, "connecting")]);
    const c = composeOnboarding(legacy.reg, registry.reg);
    expect(c.snapshot()).toEqual([
      health(DEFAULT_TENANT_ID, "connected"),
      health(OTHER, "connecting"),
    ]);
  });
});
