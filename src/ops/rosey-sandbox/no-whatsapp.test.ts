/**
 * The sandbox has no WhatsApp connection because it never LOADS one: this test
 * walks the runtime import graph of `npm run dev -- rosey-sandbox` and fails if
 * it reaches Baileys or the collector's session/socket code.
 *
 * What runs for that command:
 *  - cli.ts's static imports (commander parses before any action runs), plus
 *    its top-level `await import("./rosey/cli.js")`;
 *  - then the action's `await import("./ops/rosey-sandbox/main.js")`.
 * The sandbox and Rosey's command module are walked with dynamic imports
 * followed too (stricter than needed); cli.ts's own action bodies import the
 * collector for OTHER commands, so for cli.ts only its static graph counts.
 *
 * Only value imports count: `import type` / `export type` are erased by tsc.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── The walker ────────────────────────────────────────────────────────────────

const STATIC = [
  /^\s*import\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*export\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
];
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Value import specifiers of one source file. */
function valueImports(source: string, dynamic: boolean): string[] {
  const out: string[] = [];
  for (const re of dynamic ? [...STATIC, DYNAMIC] : STATIC) {
    for (const m of source.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

type Graph = { read: (file: string) => string; exists: (file: string) => boolean };
const disk: Graph = {
  read: (f) => fs.readFileSync(f, "utf8"),
  exists: (f) => fs.existsSync(f),
};

/** Every forbidden module reachable from `root`, with the chain that reaches it. */
function forbiddenReach(
  root: string,
  opts: { dynamic: boolean; forbidden: (spec: string, file: string | null) => boolean },
  g: Graph = disk,
): string[] {
  const via = new Map<string, string | null>([[root, null]]);
  const queue = [root];
  const hits: string[] = [];
  const chain = (f: string) => {
    const c: string[] = [];
    for (let x: string | null = f; x; x = via.get(x) ?? null) c.unshift(path.relative(SRC, x));
    return c.join(" → ");
  };
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of valueImports(g.read(file), opts.dynamic)) {
      if (!spec.startsWith(".")) {
        if (opts.forbidden(spec, null)) hits.push(`${chain(file)} → ${spec}`);
        continue;
      }
      const base = path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts");
      const next = [base, `${base}.ts`, path.join(base, "index.ts")].find(
        (c) => c.endsWith(".ts") && g.exists(c),
      );
      if (!next) continue;
      if (opts.forbidden(spec, next)) hits.push(`${chain(file)} → ${path.relative(SRC, next)}`);
      if (!via.has(next)) {
        via.set(next, file);
        queue.push(next);
      }
    }
  }
  return hits;
}

/** Baileys, or the collector code that opens/owns the WhatsApp socket. */
const WHATSAPP_FILES = [
  "collector/session.ts",
  "collector/collector.ts",
  "collector/creds-persistence.ts",
  "collector/reconnect-recovery.ts",
  "collector/backfill.ts",
];
function isWhatsApp(spec: string, file: string | null): boolean {
  if (file === null) return /baileys/i.test(spec);
  const rel = path.relative(SRC, file).split(path.sep).join("/");
  return WHATSAPP_FILES.includes(rel);
}

// ── The walker itself (a fake graph) ──────────────────────────────────────────

describe("the import walker", () => {
  const fake = (files: Record<string, string>): Graph => ({
    read: (f) => files[path.relative(SRC, f)] ?? "",
    exists: (f) => path.relative(SRC, f) in files,
  });
  const root = path.join(SRC, "a.ts");
  const opts = (dynamic: boolean) => ({ dynamic, forbidden: isWhatsApp });

  it("finds Baileys two hops away, with the chain", () => {
    const g = fake({
      "a.ts": `import { b } from "./b.js";`,
      "b.ts": `import {\n  makeWASocket,\n} from "@whiskeysockets/baileys";`,
    });
    expect(forbiddenReach(root, opts(false), g)).toEqual(["a.ts → b.ts → @whiskeysockets/baileys"]);
  });

  it("finds the collector session by file, and re-exports", () => {
    const g = fake({
      "a.ts": `export { x } from "./collector/session.js";`,
      "collector/session.ts": "",
    });
    expect(forbiddenReach(root, opts(false), g)).toEqual(["a.ts → collector/session.ts"]);
  });

  it("ignores type-only imports, which tsc erases", () => {
    const g = fake({
      "a.ts": `import type { WAMessage } from "@whiskeysockets/baileys";\nexport type { S } from "./collector/session.js";`,
      "collector/session.ts": "",
    });
    expect(forbiddenReach(root, opts(true), g)).toEqual([]);
  });

  it("follows dynamic imports only when asked", () => {
    const g = fake({
      "a.ts": `const s = await import("./collector/session.js");`,
      "collector/session.ts": "",
    });
    expect(forbiddenReach(root, opts(false), g)).toEqual([]);
    expect(forbiddenReach(root, opts(true), g)).toEqual(["a.ts → collector/session.ts"]);
  });
});

// ── The real graph ────────────────────────────────────────────────────────────

describe("rosey-sandbox never loads WhatsApp", () => {
  it.each([
    ["the sandbox (main.ts, dynamic imports too)", "ops/rosey-sandbox/main.ts", true],
    ["Rosey's commands, loaded at CLI startup", "rosey/cli.ts", true],
    ["the CLI's startup graph", "cli.ts", false],
  ])("%s", (_name, file, dynamic) => {
    expect(forbiddenReach(path.join(SRC, file), { dynamic, forbidden: isWhatsApp })).toEqual([]);
  });

  it("would notice the real collector path (the guard is not vacuous)", () => {
    // The collector's own entry must trip it: proves the deny list matches real files.
    const hits = forbiddenReach(path.join(SRC, "collector/collector.ts"), {
      dynamic: false,
      forbidden: isWhatsApp,
    });
    expect(hits.some((h) => h.endsWith("@whiskeysockets/baileys"))).toBe(true);
  });
});
