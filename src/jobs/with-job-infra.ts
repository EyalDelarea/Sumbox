import type pg from "pg";
import { type AppConfig, loadConfig } from "../config.js";
import { createDbClient } from "../db/client.js";
import type { JobBus } from "./job-bus.js";
import { PostgresJobRunRecorder } from "./job-run-recorder.js";
import { RabbitMqJobBus } from "./rabbitmq-bus.js";

/**
 * Infrastructure handed to a job command body: ONE Postgres pool (shared by
 * both queries and the job-run recorder) plus a bus wired to that pool.
 */
export interface JobInfra {
  pool: pg.Pool;
  bus: JobBus;
  config: AppConfig;
}

/**
 * Injectable factories — default to the real production wiring. Tests pass
 * fakes so `withJobInfra` can be characterized without a real Postgres/RabbitMQ.
 */
export interface WithJobInfraDeps {
  loadConfig?: () => AppConfig;
  /** Opens the single shared pool. */
  createPool?: () => pg.Pool;
  /** Builds the bus from the shared pool + config. */
  createBus?: (args: { config: AppConfig; pool: pg.Pool }) => JobBus;
}

/**
 * Run `fn` with a single shared job-infra context, then always tear it down.
 *
 * Opens exactly ONE pool via `createDbClient()` — used for both command queries
 * and the `PostgresJobRunRecorder` — instead of the historical two pools per
 * command (a bare query pool + a second pool inside `createDbClient()`). On both
 * success and failure it awaits `bus.close()` THEN `pool.end()`, in that order,
 * and propagates whatever `fn` returns (or throws).
 */
export async function withJobInfra<T>(
  fn: (infra: JobInfra) => Promise<T>,
  deps: WithJobInfraDeps = {},
): Promise<T> {
  const load = deps.loadConfig ?? loadConfig;
  const createPool = deps.createPool ?? createDbClient;
  const createBus =
    deps.createBus ??
    (({ config, pool }) =>
      new RabbitMqJobBus({ url: config.broker.url, recorder: new PostgresJobRunRecorder(pool) }));

  const config = load();
  const pool = createPool();
  const bus = createBus({ config, pool });

  try {
    return await fn({ pool, bus, config });
  } finally {
    await bus.close();
    await pool.end();
  }
}
