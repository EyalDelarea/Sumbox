/**
 * main.ts — `rosey-sandbox`: Rosey's playground on one real group, with no
 * WhatsApp connection at all.
 *
 *   1. Create <live>_rosey_sandbox on the same Postgres server and migrate it
 *      to the current schema.
 *   2. Clone the group from live through a read-only pool (clone.ts).
 *   3. Run her real engine over the copy, with an in-memory sink for sends
 *      (session.ts), behind a page on 127.0.0.1 (server.ts).
 *   4. On Ctrl-C (or a startup failure) drop the scratch database. `--cleanup`
 *      only drops it, for after a crash.
 *
 * Nothing here — or anything it imports — loads Baileys or the collector's
 * session; no-whatsapp.test.ts walks the import graph to prove it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrationsUp } from "../../db/migrate.js";
import {
  cloneGroup,
  createScratch,
  dropScratch,
  readOnlyPool,
  scratchTarget,
  wipeScratch,
} from "./clone.js";
import { SANDBOX_PAGE } from "./page.js";
import { createSandboxServer, DEFAULT_SANDBOX_PORT } from "./server.js";
import { RoseySandbox } from "./session.js";

const FONTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/public/fonts",
);

export type RoseySandboxOptions = {
  liveUrl: string;
  groupId?: number;
  port?: number;
  cleanup?: boolean;
  out?: (line: string) => void;
};

/** Runs until SIGINT/SIGTERM. Resolves once the scratch database is dropped. */
export async function runRoseySandbox(opts: RoseySandboxOptions): Promise<void> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const target = scratchTarget(opts.liveUrl);

  if (opts.cleanup) {
    await dropScratch(target);
    out(`Dropped ${target.name} (if it existed).`);
    return;
  }
  const groupId = opts.groupId;
  if (groupId === undefined || !Number.isInteger(groupId) || groupId <= 0) {
    throw new Error("--group must be a positive group id");
  }
  const port = opts.port ?? DEFAULT_SANDBOX_PORT;

  let live: pg.Pool | null = null;
  let scratch: pg.Pool | null = null;
  let sandbox: RoseySandbox | null = null;
  let server: ReturnType<typeof createSandboxServer> | null = null;

  const teardown = async () => {
    sandbox?.stop();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server?.closeAllConnections();
    await scratch?.end().catch(() => undefined);
    await live?.end().catch(() => undefined);
    await dropScratch(target);
    out(`Dropped ${target.name}.`);
  };

  try {
    out(`Creating ${target.name} and migrating it…`);
    await createScratch(target);
    await runMigrationsUp(target.url);
    live = readOnlyPool(opts.liveUrl);
    scratch = new pg.Pool({ connectionString: target.url, max: 5 });
    const report = await cloneGroup(live, scratch, groupId, target.liveName);
    out(
      `Cloned group ${groupId} (read-only from ${target.liveName}): ${Object.entries(report)
        .map(([t, n]) => `${t} ${n}`)
        .join(", ")}`,
    );

    sandbox = new RoseySandbox({ scratch, groupId });
    await sandbox.start();
    const s = sandbox;
    const sc = scratch;
    const lv = live;
    server = createSandboxServer({
      sandbox: s,
      page: SANDBOX_PAGE,
      fontsDir: FONTS_DIR,
      port,
      reset: async () => {
        s.stop();
        await wipeScratch(sc, target.liveName);
        await cloneGroup(lv, sc, groupId, target.liveName);
        await s.start();
      },
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, "127.0.0.1", resolve);
    });
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }

  out(
    `Rosey sandbox on http://127.0.0.1:${port}  (no WhatsApp; Ctrl-C drops the scratch database)`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await teardown();
}
