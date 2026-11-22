/**
 * Structural guards for Rosey's two hard boundaries, checked on the source:
 *
 *  1. She cannot send. No file in src/rosey names a WhatsApp send primitive.
 *     The send slices (gate, replies, weekly post, polls) need their own
 *     sign-off; when one lands, it changes this test on purpose, in review.
 *  2. She is isolated from @Aida (D6): nothing in src/rosey imports src/ask.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Rosey's production sources (tests excluded — this file names the words it bans). */
function roseySources(dir = DIR): Array<{ file: string; text: string }> {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

const SEND_PRIMITIVES = /\b(sendText|sendMessage|relayMessage|sendPoll|quotedFrom)\b|\.react\(/;
const ASK_IMPORT = /from\s+["'](?:\.\.\/)+ask\//;

function violations(sources: Array<{ file: string; text: string }>): string[] {
  const out: string[] = [];
  for (const { file, text } of sources) {
    if (SEND_PRIMITIVES.test(text)) out.push(`${file}: names a send primitive`);
    if (ASK_IMPORT.test(text)) out.push(`${file}: imports from src/ask`);
  }
  return out;
}

describe("Rosey isolation", () => {
  it("has production sources to check", () => {
    expect(roseySources().length).toBeGreaterThan(5);
  });

  it("never names a WhatsApp send primitive and never imports @Aida's module", () => {
    expect(violations(roseySources())).toEqual([]);
  });

  it("the guard catches each kind of violation", () => {
    expect(
      violations([
        { file: "a.ts", text: "await session.sendText(jid, 'hi')" },
        { file: "b.ts", text: "await deps.react(jid, key, '✅')" },
        { file: "c.ts", text: 'import { x } from "../ask/answer.js";' },
        { file: "d.ts", text: "const ok = titleKey(t);" },
      ]),
    ).toEqual([
      "a.ts: names a send primitive",
      "b.ts: names a send primitive",
      "c.ts: imports from src/ask",
    ]);
  });
});
