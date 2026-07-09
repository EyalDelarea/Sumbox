import type http from "node:http";
import { listGroups } from "../../db/repositories/groups.js";
import type { ServerDeps } from "./context.js";

export function handleGroups(res: http.ServerResponse, deps: ServerDeps): void {
  listGroups(deps.pool)
    .then((groups) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(groups));
    })
    .catch((err) => {
      process.stderr.write(
        `Error handling /api/groups: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error." }));
    });
}
