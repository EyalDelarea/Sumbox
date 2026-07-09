import type http from "node:http";
import { buildStatusReport, DEFAULT_STALENESS_MS } from "../../service/status.js";
import type { ServerDeps } from "./context.js";

export async function handleStatus(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const getQueueDepths = deps.getQueueDepths ?? (async () => ({}));
  const stalenessMs = deps.stalenessMs ?? DEFAULT_STALENESS_MS;
  try {
    const report = await buildStatusReport({ pool: deps.pool, getQueueDepths, stalenessMs });
    const rawLiveness = deps.getLiveness?.() ?? null;
    const liveness = rawLiveness
      ? {
          healthy: rawLiveness.healthy,
          lastHeartbeatAt: rawLiveness.lastHeartbeatAt?.toISOString() ?? null,
        }
      : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...report, liveness }));
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "status unavailable" }));
  }
}
