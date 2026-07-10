import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { JobBus } from "./job-bus.js";
import { type JobInfra, withJobInfra } from "./with-job-infra.js";

// ── Fakes ───────────────────────────────────────────────────────────────────
//
// withJobInfra hard-wires createDbClient / RabbitMqJobBus by default, so we
// inject fake factories to characterize it WITHOUT a real Postgres/RabbitMQ.
// A shared `calls` log records teardown ORDER (the contract is bus.close()
// THEN pool.end()), which a pair of independent `toHaveBeenCalled` assertions
// could not verify.

function makeFakes() {
  const calls: string[] = [];
  const end = vi.fn(async () => {
    calls.push("pool.end");
  });
  const close = vi.fn(async () => {
    calls.push("bus.close");
  });

  let poolsCreated = 0;
  const pool = { end } as unknown as pg.Pool;
  const bus = { close } as unknown as JobBus;
  const config = { broker: { url: "amqp://fake" } } as unknown as AppConfig;

  const deps = {
    loadConfig: () => config,
    createPool: () => {
      poolsCreated++;
      return pool;
    },
    createBus: vi.fn((_args: { config: AppConfig; pool: pg.Pool }) => bus),
  };

  return {
    calls,
    end,
    close,
    pool,
    bus,
    config,
    deps,
    poolsCreated: () => poolsCreated,
  };
}

describe("withJobInfra", () => {
  it("creates exactly ONE pool and passes { pool, bus, config } to fn", async () => {
    const f = makeFakes();
    let received: JobInfra | undefined;

    await withJobInfra(async (infra) => {
      received = infra;
    }, f.deps);

    expect(f.poolsCreated()).toBe(1);
    expect(received?.pool).toBe(f.pool);
    expect(received?.bus).toBe(f.bus);
    expect(received?.config).toBe(f.config);
    // The bus is built from the same single pool + config.
    expect(f.deps.createBus).toHaveBeenCalledWith({ config: f.config, pool: f.pool });
  });

  it("propagates fn's return value", async () => {
    const f = makeFakes();

    const result = await withJobInfra(async () => 42, f.deps);

    expect(result).toBe(42);
  });

  it("on success, tears down bus.close() THEN pool.end() in that order", async () => {
    const f = makeFakes();

    await withJobInfra(async () => {
      // fn did no teardown yet
      expect(f.calls).toEqual([]);
    }, f.deps);

    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(["bus.close", "pool.end"]);
  });

  it("propagates fn's error AND still tears down bus.close() THEN pool.end()", async () => {
    const f = makeFakes();
    const boom = new Error("fn failed");

    await expect(
      withJobInfra(async () => {
        throw boom;
      }, f.deps),
    ).rejects.toBe(boom);

    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(["bus.close", "pool.end"]);
  });
});
