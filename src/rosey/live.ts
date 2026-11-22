/**
 * live.ts — Rosey's entry for the collector: her engine (engine.ts) with the
 * WhatsApp message-id generator and the session's sender, switched by env.
 *
 * This is the one file of her live path that loads Baileys at runtime, so the
 * engine itself stays free of it (the sandbox runs the engine without this file).
 */

import { generateMessageIDV2 } from "@whiskeysockets/baileys";
import type pg from "pg";
import {
  getEnabledGroupJids,
  ROSEY_COMMAND_KEY,
} from "../db/repositories/group-command-permissions.js";
import { loadRoseyConfig } from "./config.js";
import { makeRoseyEngine, type RoseyEngineDeps, type RoseyLive } from "./engine.js";
import { ROSEY_SEND_SCOPE, type RoseySender, roseySender } from "./reply.js";

export type { RoseyLive } from "./engine.js";

type Log = NonNullable<RoseyEngineDeps["log"]>;

/** The engine with WhatsApp's own message ids, as the collector runs it. */
export function makeRoseyLive(deps: Omit<RoseyEngineDeps, "newMessageId">): RoseyLive {
  return makeRoseyEngine({ ...deps, newMessageId: () => generateMessageIDV2() });
}

/**
 * The collector's entry point: Rosey's live capture when ROSEY_ENABLED=true,
 * otherwise undefined (attachCollector then never calls her). Off is the default.
 */
export function roseyLiveFromEnv(
  pool: pg.Pool,
  log?: Log,
  env: NodeJS.ProcessEnv = process.env,
  sender?: RoseySender,
): RoseyLive | undefined {
  const cfg = loadRoseyConfig(env);
  if (!cfg.enabled) return undefined;
  log?.info(
    { tags: cfg.tags, debounceMs: cfg.suggestDebounceMs, sendMode: cfg.sendMode },
    cfg.sendMode === "live"
      ? "rosey: live capture on; list replies LIVE to groups on her list"
      : "rosey: live capture on",
  );
  // Her scope on every send: the outbound guard admits her groups to nothing else.
  return makeRoseyLive({ pool, cfg, log, sender: sender && roseySender(sender) });
}

/**
 * The outbound guard's scoped allowlists for a collector: Rosey's groups,
 * admitted ONLY to sends inside her send scope (reply.ts roseySender), and only
 * when she is enabled and ROSEY_SEND_MODE=live. The shared allowlist (/סיכום and
 * @Aida) is never widened, so @Aida can never send to a group only Rosey is in.
 * Re-read per send; a failed read throws, which blocks the send.
 */
export function roseyScopedAllowlistsFromEnv(
  pool: pg.Pool,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, () => Promise<ReadonlySet<string>>> {
  const cfg = loadRoseyConfig(env);
  if (!cfg.enabled || cfg.sendMode !== "live") return {};
  return {
    [ROSEY_SEND_SCOPE]: async () => new Set(await getEnabledGroupJids(pool, ROSEY_COMMAND_KEY)),
  };
}
