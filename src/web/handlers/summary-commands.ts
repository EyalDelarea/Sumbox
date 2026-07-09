import type http from "node:http";
import {
  listGroupsWithPermission,
  upsertCommandPermission,
} from "../../db/repositories/group-command-permissions.js";
import {
  DEFAULT_SUMMARY_TRIGGER,
  getPreferences,
  setSummaryCommandTrigger,
} from "../../db/repositories/user-preferences.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

export type SummaryCommandsUpdate = {
  groupId: number;
  enabled: boolean;
};

/**
 * GET  /api/summary-commands — the current /סיכום trigger plus all groups with
 * their permission status.
 * PUT  /api/summary-commands — either toggle a group's permission ({ groupId,
 * enabled }) or update the trigger itself ({ trigger }). Either way the next
 * /סיכום message picks up the change automatically (the matcher reads the DB
 * live, per message — no reload to trigger here).
 */
export async function handleSummaryCommands(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method === "GET") return getCommands(res, deps);
  if (req.method === "PUT") return putCommands(req, res, deps);
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed." }));
}

async function getCommands(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const [prefs, groups] = await Promise.all([
      getPreferences(deps.pool),
      listGroupsWithPermission(deps.pool),
    ]);
    const trigger = prefs?.summaryCommandTrigger ?? DEFAULT_SUMMARY_TRIGGER;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ trigger, groups }));
  } catch (err) {
    deps.logger?.warn({ err }, "failed to load summary command permissions");
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load summary command permissions." }));
  }
}

async function putCommands(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);

  if (body && typeof body["trigger"] === "string") {
    try {
      await setSummaryCommandTrigger(deps.pool, body["trigger"] as string);
    } catch (err) {
      deps.logger?.warn({ err }, "rejected invalid /סיכום trigger");
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid trigger." }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!body || typeof body["groupId"] !== "number" || typeof body["enabled"] !== "boolean") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Expected { groupId, enabled } or { trigger }." }));
    return;
  }

  try {
    await upsertCommandPermission(deps.pool, {
      groupId: body["groupId"] as number,
      enabled: body["enabled"] as boolean,
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    deps.logger?.warn({ err }, "failed to update summary command permission");
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to update summary command permission." }));
  }
}
