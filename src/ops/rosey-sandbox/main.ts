/**
 * main.ts — `rosey-sandbox`: Rosey's playground on one real group, with no
 * WhatsApp connection at all.
 *
 *   1. Create <live>_rosey_sandbox on the same Postgres server and migrate it
 *      to the current schema (refused if another run is using it).
 *   2. Clone the group from live through a read-only pool (clone.ts).
 *   3. Run her real engine over the copy, with an in-memory sink for sends
 *      (session.ts), behind a page on 127.0.0.1 (server.ts).
 *   4. On Ctrl-C, SIGTERM or SIGHUP (a closed terminal), on a startup failure,
 *      and best effort on an uncaught error, drop the scratch database.
 *      `--cleanup` only drops it, for after a crash that left it behind (a
 *      kill -9 cannot be caught); a run that finds one says so.
 *
 * Nothing here — or anything it imports — loads Baileys or the collector's
 * session; no-whatsapp.test.ts walks the import graph to prove it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  cloneGroup,
  createScratch,
  dropScratch,
  openScratch,
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

const CLEANUP_HINT = "npm run dev -- rosey-sandbox --cleanup";

/** How long a crashed run waits for its teardown before it exits anyway. */
const CRASH_TEARDOWN_MS = 15_000;

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const CRASH_EVENTS = ["uncaughtException", "unhandledRejection"] as const;

/**
 * End the run on a stop signal (`stop`) and on an uncaught error (`crash`,
 * which must tear down and exit non-zero: a listener replaces Node's own
 * crash). Returns the function that removes every listener again.
 */
export function watchExit(
  proc: NodeJS.EventEmitter,
  h: { stop: (signal: string) => void; crash: (err: unknown) => void },
): () => void {
  const stops = STOP_SIGNALS.map((s) => [s, () => h.stop(s)] as const);
  const crash = (err: unknown) => h.crash(err);
  for (const [s, fn] of stops) proc.on(s, fn);
  for (const e of CRASH_EVENTS) proc.on(e, crash);
  return () => {
    for (const [s, fn] of stops) proc.off(s, fn);
    for (const e of CRASH_EVENTS) proc.off(e, crash);
  };
}

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

  // Listen from the start: a Ctrl-C during migrate/clone lets startup finish
  // its current step and then tears down, instead of killing the process with
  // a copy of the chat left behind.
  let stopRequested = false;
  let wake: (() => void) | null = null;
  const unwatch = watchExit(process, {
    stop: () => {
      stopRequested = true;
      wake?.();
    },
    crash: (err) => {
      out(`rosey-sandbox crashed: ${(err as Error)?.stack ?? String(err)}`);
      // Exit even if teardown hangs (an unreachable database): the --cleanup
      // hint is printed below either way.
      setTimeout(() => {
        out(`Teardown did not finish. If ${target.name} is left: ${CLEANUP_HINT}`);
        process.exit(1);
      }, CRASH_TEARDOWN_MS).unref();
      void teardown()
        .catch(() => undefined) // teardown already printed the --cleanup hint
        .finally(() => process.exit(1));
    },
  });

  let created = false;
  let live: pg.Pool | null = null;
  let scratch: pg.Pool | null = null;
  let sandbox: RoseySandbox | null = null;
  let server: ReturnType<typeof createSandboxServer> | null = null;

  // One teardown, however many ways the run ends at once (a signal and a crash).
  let tearing: Promise<void> | null = null;
  const teardown = () => {
    tearing ??= tearDown();
    return tearing;
  };
  const tearDown = async () => {
    unwatch();
    sandbox?.stop();
    if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
    server?.closeAllConnections();
    await scratch?.end().catch(() => undefined);
    await live?.end().catch(() => undefined);
    if (!created) return; // never drop a database this run did not create
    try {
      await dropScratch(target);
      out(`Dropped ${target.name}.`);
    } catch (err) {
      out(
        `Could NOT drop ${target.name} (${(err as Error).message}): it holds a copy of the chat. ` +
          `Run: ${CLEANUP_HINT}`,
      );
      throw err;
    }
  };

  try {
    out(`Creating ${target.name} and migrating it…`);
    const { leftover } = await createScratch(target);
    created = true;
    if (leftover) {
      out(
        `Found a leftover ${target.name} from an earlier run (a copy of the chat) and replaced ` +
          `it. To drop one without starting the sandbox: ${CLEANUP_HINT}`,
      );
    }
    scratch = await openScratch(target);
    live = readOnlyPool(opts.liveUrl);
    const lv = live;
    const sc = scratch;
    const report = await cloneGroup(lv, sc, groupId, target.liveName, out);
    out(
      `Cloned group ${groupId} (read-only from ${target.liveName}): ${Object.entries(report)
        .map(([t, n]) => `${t} ${n}`)
        .join(", ")}`,
    );

    const s = new RoseySandbox({ scratch: sc, groupId });
    sandbox = s;
    await s.start();
    server = createSandboxServer({
      sandbox: s,
      page: SANDBOX_PAGE,
      fontsDir: FONTS_DIR,
      port,
      reset: () =>
        s.reset(async () => {
          await wipeScratch(sc, target.liveName);
          await cloneGroup(lv, sc, groupId, target.liveName, out);
        }),
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, "127.0.0.1", resolve);
    });
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }

  if (!stopRequested) {
    out(
      `Rosey sandbox on http://127.0.0.1:${port}  (no WhatsApp; Ctrl-C drops the scratch database)`,
    );
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await teardown();
}
