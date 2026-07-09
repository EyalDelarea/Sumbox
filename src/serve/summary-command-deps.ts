import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import { getEnabledGroupJids } from "../db/repositories/group-command-permissions.js";
import { DEFAULT_SUMMARY_TRIGGER, getPreferences } from "../db/repositories/user-preferences.js";

type MinimalLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

/**
 * The runtime state behind the /סיכום command handler. `resolveEnabledJids` /
 * `resolveTrigger` read the DB live, per candidate message — there is no
 * in-memory snapshot to hot-reload; toggling a group or the trigger in the UI
 * takes effect on the very next message, in every process topology.
 */
export type SummaryCommandRuntimeDeps = {
  resolveEnabledJids: () => Promise<ReadonlySet<string>>;
  resolveTrigger: () => Promise<string>;
  inFlight: Set<number>;
  lastSummaryByUser: Map<string, WAMessage>;
};

/**
 * Build the /סיכום command deps, bound to the given (tenant-scoped) pool. No DB
 * read happens at construction — the resolvers are called lazily, per message,
 * by the matcher — so this can never fail at construction; a DB error is the
 * matcher's problem to fail-closed on, not this factory's.
 */
export function makeSummaryCommandDeps(
  pool: Pick<pg.Pool, "query">,
  _log: MinimalLog,
): SummaryCommandRuntimeDeps {
  return {
    resolveEnabledJids: async () => new Set(await getEnabledGroupJids(pool as pg.Pool)),
    resolveTrigger: async () =>
      (await getPreferences(pool as pg.Pool))?.summaryCommandTrigger ?? DEFAULT_SUMMARY_TRIGGER,
    inFlight: new Set<number>(),
    lastSummaryByUser: new Map(),
  };
}
