import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeOnboardingRoutes } from "../web/onboarding-routes.js";
import { OnboardingAdapter } from "./onboarding-adapter.js";

describe("OnboardingAdapter", () => {
  it("starts 'connecting' when no device is linked", () => {
    const a = new OnboardingAdapter({ initiallyLinked: false });
    expect(a.snapshot()).toEqual({
      status: "connecting",
      restarts: 0,
      lastError: null,
      lastConnectedAt: null,
    });
  });

  it("starts 'connected' when a device is already linked (gate skips onboarding)", () => {
    const a = new OnboardingAdapter({ initiallyLinked: true });
    expect(a.snapshot().status).toBe("connected");
  });

  it("re-emits the session's events", () => {
    const src = new EventEmitter();
    const a = new OnboardingAdapter({ initiallyLinked: false });
    a.attachSession(src);
    const seen: unknown[][] = [];
    a.on("qr", (...args) => seen.push(["qr", ...args]));
    a.on("connected", (...args) => seen.push(["connected", ...args]));
    a.on("history-progress", (...args) => seen.push(["history-progress", ...args]));
    src.emit("qr", "QR-1");
    src.emit("history-progress", { progress: 42, count: 9 });
    src.emit("connected");
    expect(seen).toEqual([
      ["qr", "QR-1"],
      ["history-progress", { progress: 42, count: 9 }],
      ["connected"],
    ]);
    expect(a.snapshot().status).toBe("connected");
  });

  it("replays the buffered QR to a late subscriber", () => {
    const src = new EventEmitter();
    const a = new OnboardingAdapter({ initiallyLinked: false });
    a.attachSession(src);
    src.emit("qr", "QR-LATE"); // emitted before anyone subscribes
    const got: unknown[][] = [];
    a.on("qr", (...args) => got.push(args)); // subscribe afterwards
    expect(got).toEqual([["QR-LATE"]]);
  });

  it("does not replay a stale QR once connected", () => {
    const src = new EventEmitter();
    const a = new OnboardingAdapter({ initiallyLinked: false });
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
    const a = new OnboardingAdapter({ initiallyLinked: true });
    const routes = makeOnboardingRoutes({ registry: a });
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void routes.handle(req, res, url).then((h) => {
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
