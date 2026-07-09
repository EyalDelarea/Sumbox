import type http from "node:http";
import { findGroupByName } from "../../db/repositories/groups.js";
import { listSummariesByGroup, setSummaryRating } from "../../db/repositories/summaries.js";
import { getLogger } from "../../logging/log.js";
import { normalizeSummaryOutput } from "../../summarization/normalize.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

// Content-free quality signal (Grafana component="summary-rating"): numeric id +
// enum code only — NEVER summary text, message body, sender, or chat name.
const summaryRatingLog = getLogger("summary-rating");
const REASONS = new Set(["missed", "inaccurate", "too_long", "too_short"]);

export async function handleSummaries(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const p = url.pathname;
  const m = req.method;
  const rating = /^\/api\/summaries\/(\d+)\/rating$/.exec(p);
  if (m === "POST" && rating) return rateSummary(Number(rating[1]), req, res, deps);
  if (m === "GET" && p === "/api/summaries") return listSummaries(url, res, deps);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Unknown summaries route." }));
}

async function rateSummary(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const rawRating = body?.["rating"];
    const rating = rawRating === 1 ? 1 : rawRating === -1 ? -1 : null;
    const rawReason = body?.["reason"];
    const reason = typeof rawReason === "string" && REASONS.has(rawReason) ? rawReason : null;
    const ok = await setSummaryRating(deps.pool, id, rating, reason);
    if (!ok) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown summary." }));
      return;
    }
    summaryRatingLog.info({ summaryId: id, rating, reason }, "summary rated");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rating }));
  } catch (err) {
    process.stderr.write(
      `Error handling /api/summaries rating: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error." }));
    }
  }
}

async function listSummaries(url: URL, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const group = url.searchParams.get("group");
  if (!group) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing group." }));
    return;
  }
  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
  }
  try {
    const grp = await findGroupByName(deps.pool, group);
    if (!grp) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    const summaries = await listSummariesByGroup(deps.pool, grp.id, limit);
    const serialized = summaries.map((s) => ({
      id: s.id,
      summaryType: s.summaryType,
      parameters: s.parameters,
      output: normalizeSummaryOutput(s.output),
      model: s.model,
      createdAt: s.createdAt.toISOString(),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(serialized));
  } catch (err) {
    process.stderr.write(
      `Error handling /api/summaries: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error." }));
  }
}
