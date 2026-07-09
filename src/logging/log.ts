import { loadConfig } from "../config.js";
import { childLogger, createLogger, type Logger } from "./logger.js";

/**
 * Process-wide singleton base logger.
 *
 * Built once, lazily, from the app config (LOG_LEVEL). Every component obtains a
 * child of this single base via getLogger(), so there is exactly one pino
 * transport (stdout) per process.
 */
let base: Logger | undefined;

/** Returns the singleton base logger, constructing it on first use. */
export function getBaseLogger(): Logger {
  if (!base) {
    base = createLogger(loadConfig().logging);
  }
  return base;
}

/**
 * Returns a child logger tagged with { component }. Cheap; safe to call per
 * call-site or to cache at module scope. The component appears on every line and
 * composes with any further .child() context (e.g. jobId in the worker).
 */
export function getLogger(component: string): Logger {
  return childLogger(getBaseLogger(), { component });
}

/** Test/teardown only: reset the singleton so the next getBaseLogger() rebuilds it. */
export function __resetBaseLoggerForTest(): void {
  base = undefined;
}
