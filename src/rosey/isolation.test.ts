/**
 * Structural guards for Rosey's two hard boundaries, checked on the source:
 *
 *  1. She sends only through her gate. One file of hers, rosey/reply.ts (the
 *     list reply behind her send gate), may name `sendText`, and nothing else;
 *     no other file of hers names a WhatsApp send primitive at all. Each
 *     further send slice (weekly post, polls, reactions) needs its own
 *     sign-off, and changes this test on purpose, in review.
 *  2. She is isolated from @Aida (D6): no module she can load — directly or
 *     through any chain of imports, static or dynamic — lives in src/ask.
 *
 * "Her files" are every production source under src/rosey (any depth) and her
 * repositories (src/db/repositories/rosey-*.ts). Boundary 2 walks the whole
 * import graph out from them. A dynamic import whose specifier is not a string
 * literal cannot be followed, so it is itself a violation in her files.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── The graph ─────────────────────────────────────────────────────────────────

type Reader = (file: string) => string | null;

const diskReader: Reader = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

const isProd = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");

function walkDir(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walkDir(p) : isProd(p) ? [p] : [];
  });
}

/** Rosey's own production files. */
function roseyRoots(): string[] {
  const repos = path.join(SRC, "db", "repositories");
  return [
    ...walkDir(path.join(SRC, "rosey")),
    ...fs
      .readdirSync(repos)
      .filter((f) => f.startsWith("rosey-") && isProd(f))
      .map((f) => path.join(repos, f)),
  ];
}

const SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g, // import … from, export … from
  /\bimport\s*["']([^"']+)["']/g, // side-effect import
  /\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g, // dynamic import of a literal
];
// The lookahead holds the whitespace inside it, so a literal on the next line is
// not mistaken for a computed specifier.
const COMPUTED_DYNAMIC_IMPORT = /\bimport\s*\((?!\s*["'`])|\bimport\s*\(\s*`[^`]*\$\{/;

function importsOf(text: string): string[] {
  return SPECIFIERS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));
}

/** A relative specifier as the .ts file it names, or null for a package import. */
function resolve(from: string, spec: string, read: Reader): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  return candidates.find((c) => c.endsWith(".ts") && read(c) !== null) ?? null;
}

const SEND_PRIMITIVES = /\b(sendText|sendMessage|relayMessage|sendPoll|quotedFrom)\b|\.react\(/;
/** The one file that may send, and the one primitive it may name. */
const SEND_GATE = path.join("rosey", "reply.ts");
const GATE_PRIMITIVE = /\bsendText\b/g;
const ASK_DIR = `${path.join(SRC, "ask")}${path.sep}`;

/** Every boundary violation reachable from `roots`, as readable lines. */
function violations(roots: readonly string[], read: Reader = diskReader): string[] {
  const out: string[] = [];
  const rel = (f: string) => path.relative(SRC, f);
  for (const file of roots) {
    const raw = read(file) ?? "";
    const text = rel(file) === SEND_GATE ? raw.replace(GATE_PRIMITIVE, "") : raw;
    if (SEND_PRIMITIVES.test(text)) out.push(`${rel(file)}: names a send primitive`);
    if (COMPUTED_DYNAMIC_IMPORT.test(raw)) out.push(`${rel(file)}: has a computed dynamic import`);
  }
  // Breadth-first over the import graph, remembering how each file was reached.
  const via = new Map<string, string | null>(roots.map((r) => [r, null]));
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.startsWith(ASK_DIR)) {
      const chain: string[] = [];
      for (let f: string | null = file; f; f = via.get(f) ?? null) chain.unshift(rel(f));
      out.push(`reaches src/ask: ${chain.join(" -> ")}`);
      continue;
    }
    for (const spec of importsOf(read(file) ?? "")) {
      const next = resolve(file, spec, read);
      if (next && !via.has(next)) {
        via.set(next, file);
        queue.push(next);
      }
    }
  }
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Rosey isolation", () => {
  it("has her files to check, including her repositories", () => {
    const roots = roseyRoots().map((f) => path.relative(SRC, f));
    expect(roots.length).toBeGreaterThan(5);
    expect(roots).toContain(path.join("db", "repositories", "rosey-tasks.ts"));
  });

  it("sends only through her gate and can never load @Aida's module", () => {
    expect(violations(roseyRoots())).toEqual([]);
  });

  it("her gate exists and is the file that sends", () => {
    const gate = fs.readFileSync(path.join(SRC, SEND_GATE), "utf8");
    expect(gate).toMatch(GATE_PRIMITIVE);
  });

  describe("the guard catches each kind of violation", () => {
    const at = (p: string) => path.join(SRC, p);
    const graph =
      (files: Record<string, string>): Reader =>
      (f) =>
        files[path.relative(SRC, f)] ?? null;
    const clean = { "ask/answer.ts": "export const a = 1;", "util/x.ts": "export const x = 1;" };

    it("a send primitive", () => {
      const read = graph({ ...clean, "rosey/a.ts": "await session.sendText(jid, 'hi')" });
      expect(violations([at("rosey/a.ts")], read)).toEqual(["rosey/a.ts: names a send primitive"]);
      const r2 = graph({ ...clean, "rosey/b.ts": "await deps.react(jid, key, '✅')" });
      expect(violations([at("rosey/b.ts")], r2)).toEqual(["rosey/b.ts: names a send primitive"]);
    });

    it("her gate may name sendText, and only sendText", () => {
      const ok = graph({ ...clean, "rosey/reply.ts": "await deps.sender.sendText(jid, text)" });
      expect(violations([at("rosey/reply.ts")], ok)).toEqual([]);
      const poll = graph({ ...clean, "rosey/reply.ts": "await sock.sendMessage(jid, { poll })" });
      expect(violations([at("rosey/reply.ts")], poll)).toEqual([
        "rosey/reply.ts: names a send primitive",
      ]);
      const elsewhere = graph({ ...clean, "rosey/live.ts": "io.sendText(jid, text)" });
      expect(violations([at("rosey/live.ts")], elsewhere)).toEqual([
        "rosey/live.ts: names a send primitive",
      ]);
    });

    it("a static import, a re-export and a dynamic import of src/ask", () => {
      for (const text of [
        'import { a } from "../ask/answer.js";',
        'export { a } from "../ask/answer.js";',
        'const m = await import("../ask/answer.js");',
      ]) {
        const read = graph({ ...clean, "rosey/c.ts": text });
        expect(violations([at("rosey/c.ts")], read)).toEqual([
          "reaches src/ask: rosey/c.ts -> ask/answer.ts",
        ]);
      }
    });

    it("an indirect import, from a subfolder", () => {
      const read = graph({
        ...clean,
        "rosey/sub/d.ts": 'import { x } from "../../util/x.js";',
        "util/x.ts": 'export { a as x } from "../ask/answer.js";',
      });
      expect(violations([at("rosey/sub/d.ts")], read)).toEqual([
        "reaches src/ask: rosey/sub/d.ts -> util/x.ts -> ask/answer.ts",
      ]);
    });

    it("a dynamic import it cannot follow", () => {
      const read = graph({ ...clean, "rosey/e.ts": "const m = await import(name);" });
      expect(violations([at("rosey/e.ts")], read)).toEqual([
        "rosey/e.ts: has a computed dynamic import",
      ]);
    });

    it("nothing, for clean code", () => {
      const read = graph({ ...clean, "rosey/f.ts": 'import { x } from "../util/x.js";' });
      expect(violations([at("rosey/f.ts")], read)).toEqual([]);
    });
  });
});
