import { getBaseLogger } from "./log.js";
import type { Logger } from "./logger.js";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const REDACTED = "[redacted]";
const MAX_DEPTH = 5;

/** Object keys whose values are cryptographic material and must never be logged. */
const SENSITIVE_KEYS = new Set(["privKey", "rootKey", "chainKey", "baseKey", "ephemeralKeyPair"]);

/** Lines whose first string arg matches this are dropped entirely (libsignal key dump). */
const DROP_PREFIX = /^Closing session:/;

/** console method -> pino method. */
const LEVEL_MAP: Record<ConsoleMethod, "info" | "warn" | "error" | "debug"> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/** Marker stamped on each wrapped console method so re-install is a no-op. */
const GUARD_MARK = "__sumboxConsoleGuard";

/** Replace any Buffer/typed-array with a marker; redact sensitive keys in plain objects. */
function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Uint8Array || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return REDACTED;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  if (seen.has(value as object)) {
    return "[circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

/**
 * Install a process-wide guard over console.* so that:
 *  - the libsignal "Closing session:" private-key dump is dropped;
 *  - Buffer / sensitive-key payloads are redacted;
 *  - all remaining output is routed through `base` tagged { source: "console" }
 *    at the mapped level, so no line escapes attribution (FR-003).
 *
 * The guard never propagates a failure to the caller (FR-013): on any internal
 * error it falls back to the original console method. Idempotent; returns a
 * restore() that reinstates the original methods.
 */
export function installConsoleGuard(base?: Logger): () => void {
  const logger = base ?? getBaseLogger();
  const con = console as unknown as Record<
    string,
    ((...a: unknown[]) => void) & { [k: string]: unknown }
  >;
  const methods: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

  // Already wrapped — return a no-op restore so callers don't double-restore.
  if (con.log?.[GUARD_MARK]) {
    return () => {};
  }

  const originals: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

  const restore = () => {
    for (const m of methods) {
      const orig = originals[m];
      if (orig) {
        con[m] = orig as typeof con.log;
      }
    }
  };

  for (const method of methods) {
    // Keep the raw reference for exact-identity restore; bind a copy for fallback calls.
    const original = con[method] as (...a: unknown[]) => void;
    originals[method] = original;
    const boundOriginal = original.bind(console);

    const wrapper = (...args: unknown[]) => {
      try {
        // Drop the libsignal session dump (carries private keys).
        if (typeof args[0] === "string" && DROP_PREFIX.test(args[0])) {
          return;
        }

        const fields: Record<string, unknown> = { source: "console" };
        const msgParts: string[] = [];
        const extras: unknown[] = [];

        for (const arg of args) {
          if (typeof arg === "string") {
            msgParts.push(arg);
          } else if (arg instanceof Error) {
            fields.err = arg;
          } else {
            extras.push(redact(arg));
          }
        }
        if (extras.length === 1) {
          fields.detail = extras[0];
        } else if (extras.length > 1) {
          fields.detail = extras;
        }

        const pinoMethod = LEVEL_MAP[method];
        logger[pinoMethod](fields, msgParts.join(" "));
      } catch {
        // Logging must never break the caller — fall back to raw output.
        try {
          boundOriginal(...args);
        } catch {
          /* give up silently */
        }
      }
    };
    (wrapper as unknown as Record<string, unknown>)[GUARD_MARK] = true;
    con[method] = wrapper as typeof con.log;
  }

  return restore;
}
