import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxServer, type SandboxServerDeps } from "./server.js";

const calls: unknown[] = [];
const sandbox: SandboxServerDeps["sandbox"] = {
  listStyle: "poll",
  state: async () => ({ ok: "state" }) as never,
  post: async (input) => {
    calls.push(["post", input]);
    return "ID1";
  },
  vote: async (input) => {
    calls.push(["vote", input]);
  },
  suggestNow: () => {
    calls.push(["suggest"]);
  },
  setStatus: async (id, status) => {
    calls.push(["set", id, status]);
  },
};

let server: http.Server;
let port: number;

beforeAll(async () => {
  // Bind first to learn a free port, then build the server for that port.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  server = createSandboxServer({
    sandbox,
    reset: async () => {
      calls.push(["reset"]);
    },
    page: "<html>page</html>",
    fontsDir: "/nonexistent",
    port,
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = { "content-type": "application/json" };

describe("the sandbox server", () => {
  it("serves the page and the state to this host", async () => {
    expect(await request("GET", "/")).toEqual({ status: 200, body: "<html>page</html>" });
    expect((await request("GET", "/api/state")).body).toBe('{"ok":"state"}');
  });

  it("refuses a request naming another host (DNS rebinding)", async () => {
    const r = await request("GET", "/api/state", { host: `evil.example:${port}` });
    expect(r.status).toBe(421);
  });

  it("refuses a cross-origin POST and a non-JSON POST", async () => {
    const before = calls.length;
    const cross = await request(
      "POST",
      "/api/suggest",
      { ...json, origin: "http://evil.example" },
      "{}",
    );
    expect(cross.status).toBe(403);
    const form = await request(
      "POST",
      "/api/suggest",
      { "content-type": "text/plain", origin: `http://127.0.0.1:${port}` },
      "{}",
    );
    expect(form.status).toBe(415);
    expect(calls.length).toBe(before);
  });

  it("routes same-origin actions to the sandbox, validating their input", async () => {
    const origin = { ...json, origin: `http://localhost:${port}` };
    const post = await request(
      "POST",
      "/api/post",
      origin,
      '{"member":1,"text":"hi","quotedId":"Q"}',
    );
    expect(JSON.parse(post.body)).toEqual({ ok: true, result: { id: "ID1" } });
    expect(calls.at(-1)).toEqual(["post", { member: 1, text: "hi", quotedId: "Q" }]);

    const bad = await request("POST", "/api/task", origin, '{"id":3,"status":"deleted"}');
    expect(bad.status).toBe(400);
    await request("POST", "/api/task", origin, '{"id":3,"status":"done"}');
    expect(calls.at(-1)).toEqual(["set", 3, "done"]);

    await request("POST", "/api/style", origin, '{"style":"text"}');
    expect(sandbox.listStyle).toBe("text");
    await request("POST", "/api/reset", origin, "{}");
    expect(calls.at(-1)).toEqual(["reset"]);
  });
});
