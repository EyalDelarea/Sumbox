#!/usr/bin/env node
// ── scripts/prune-dead-css.mjs ───────────────────────────────────────────────
// Dead-CSS sweep for src/web/public/styles.css — drops rules left dead after
// PRs #51/#53 retired the Create (צור) and Ask (שאל) front-end surfaces.
//
// Scope is deliberately narrow: only class selectors matching the retired-surface
// prefixes  .ama-*  .ask-*  .notif-*  and the exact class  .ama2 . A target class
// is DEAD when it has zero whole-token references in the web sources (app.js /
// *.html). Non-target classes (.scope*, .asktoast, ids, …) are never touched.
//
// Removal is per-selector and reference-driven, never prefix-blind:
//   • A comma-segment is dropped iff it contains ≥1 dead target class — a dead
//     class anywhere in the chain means the selector can never match (e.g.
//     `.ama-head .back-btn` goes because `.ama-head` is dead).
//   • A segment touching only live/non-target classes is kept (e.g. `.notif-head`
//     is LIVE — the lock-screen preview uses it — so its rules survive even though
//     they sit in the dead notif-panel block and cascade onto the live preview).
//   • A rule with mixed segments keeps only the live ones (string surgery on the
//     raw selector → minimal diff).
//   • An @media/@supports is dropped once it has no surviving rule.
//   • A @keyframes is dropped only when our removal orphaned it AND no surviving
//     rule and no JS/HTML source still names it.
//   • A section-banner / doc comment is dropped once the region it heads holds no
//     surviving rule.
//
// Usage:
//   node scripts/prune-dead-css.mjs          # apply (write the file)
//   node scripts/prune-dead-css.mjs --dry    # report only, write nothing
//
// Dev-only (postcss is a devDependency). biome ignores src/web/public, so the
// result is verified manually: build → serve dist/web/public → screenshot.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "src/web/public");
const CSS_PATH = join(PUBLIC_DIR, "styles.css");
const DRY = process.argv.includes("--dry");

// ── Target classification ────────────────────────────────────────────────────
const isTarget = (cls) =>
  cls.startsWith("ama-") ||
  cls.startsWith("ask-") ||
  cls.startsWith("notif-") ||
  cls === "ama2";

// Whole-token reference test. Class names contain hyphens, so a plain \b is
// wrong; we require the token not be flanked by [\w-] — `ama-head` then does NOT
// match inside `ama-header` or `ama-head-foo`. Erring toward "referenced" is the
// safe bias: a false positive keeps a rule, a false negative would delete a live
// one.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function makeRefIndex(text) {
  const cache = new Map();
  return (token) => {
    if (cache.has(token)) return cache.get(token);
    const hit = new RegExp(`(?<![\\w-])${escapeRe(token)}(?![\\w-])`).test(text);
    cache.set(token, hit);
    return hit;
  };
}

// Front-end reference corpus: app.js + every .html under the public dir.
function gatherRefText() {
  const files = readdirSync(PUBLIC_DIR).filter((f) => /\.(js|html)$/.test(f));
  return files.map((f) => readFileSync(join(PUBLIC_DIR, f), "utf8")).join("\n");
}

// ── Selector helpers ─────────────────────────────────────────────────────────
// Split on TOP-LEVEL commas only (don't break inside :not(...) / [..]). Each part
// keeps its own surrounding whitespace, so kept.join(",") reproduces the original
// formatting minus the dropped segments.
function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let buf = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  return parts;
}

const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;
function classesIn(segment) {
  const out = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(segment))) out.push(m[1]);
  return out;
}

const segmentIsDead = (segment, isRef) =>
  classesIn(segment).some((c) => isTarget(c) && !isRef(c));

// Pull bare identifiers from a decl value. For the `animation` shorthand this
// over-collects (`ease`, `infinite`, …) but those are only ever tested for
// membership against real @keyframes names, so the noise is harmless.
const identsIn = (value) => value.match(/[A-Za-z_][\w-]*/g) || [];

const isBanner = (comment) => /[─═]/.test(comment.text); // Sumbox dividers

// ── Sweep ────────────────────────────────────────────────────────────────────
function main() {
  const css = readFileSync(CSS_PATH, "utf8");
  const isRef = makeRefIndex(gatherRefText());
  const root = postcss.parse(css, { from: CSS_PATH });

  const removed = new Set(); // nodes to drop (rules / at-rules / comments)
  const edits = []; // { before, after } for audit
  const removedAnim = new Set(); // animation names used by fully-removed rules
  let removedRules = 0;

  // Audit: partition every target class found in the CSS into dead/live.
  const targetsSeen = new Set();
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/i.test(rule.parent.name)) return;
    for (const seg of splitTopLevel(rule.selector))
      for (const c of classesIn(seg)) if (isTarget(c)) targetsSeen.add(c);
  });
  const deadClasses = [...targetsSeen].filter((c) => !isRef(c)).sort();
  const liveClasses = [...targetsSeen].filter((c) => isRef(c)).sort();

  // Pass 1 — rules (including those nested in @media/@supports).
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/i.test(rule.parent.name)) return;
    const segs = splitTopLevel(rule.selector);
    const keep = segs.filter((s) => !segmentIsDead(s, isRef));
    if (keep.length === segs.length) return; // nothing dead → leave untouched

    if (keep.length === 0) {
      rule.walkDecls(/^animation(-name)?$/i, (d) =>
        identsIn(d.value).forEach((n) => removedAnim.add(n)),
      );
      removed.add(rule);
      removedRules++;
    } else {
      const before = rule.selector;
      const after = keep.join(",");
      delete rule.raws.selector; // force re-stringify from .selector
      rule.selector = after;
      edits.push({ before, after });
    }
  });

  // Pass 2 — at-rules emptied by pass 1 (a comment-only remnant counts as empty).
  root.walkAtRules((at) => {
    if (/keyframes/i.test(at.name) || !at.nodes) return;
    const hasSurvivor = at.nodes.some(
      (n) => n.type !== "comment" && !removed.has(n),
    );
    if (!hasSurvivor) removed.add(at);
  });

  // Pass 3 — animation names still referenced by survivors (CSS + JS/HTML).
  const survivingAnim = new Set();
  root.walkDecls(/^animation(-name)?$/i, (d) => {
    for (let p = d.parent; p; p = p.parent) if (removed.has(p)) return;
    identsIn(d.value).forEach((n) => survivingAnim.add(n));
  });

  // Pass 3b — @keyframes our removal orphaned and nobody else uses.
  const removedKeyframes = [];
  root.walkAtRules(/keyframes/i, (at) => {
    if (removed.has(at)) return;
    const name = at.params.trim();
    if (removedAnim.has(name) && !survivingAnim.has(name) && !isRef(name)) {
      removed.add(at);
      removedKeyframes.push(name);
    }
  });

  // Pass 4 — orphaned comments: a comment (section banner or doc note) is dropped
  // only when it *directly headed* rules that were all removed — i.e. the region
  // from it up to the next banner / end of block had ≥1 rule and none survived.
  // Requiring a removed rule (not just "is a banner") is what protects structural
  // headers: a `═══` super-banner immediately followed by a `──` sub-banner heads
  // no rule of its own, so it stays; only a banner whose own rules all vanished
  // (e.g. the retired "Ask prototype" block) is removed. The next-banner boundary
  // stops the scan from reaching a later live section and falsely keeping the
  // comment.
  const containers = new Set([root]);
  root.walkAtRules((at) => {
    if (at.nodes && !removed.has(at)) containers.add(at);
  });
  let removedComments = 0;
  for (const container of containers) {
    const kids = container.nodes || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type !== "comment" || removed.has(c)) continue;
      let sawRule = false;
      let sawSurvivor = false;
      for (let j = i + 1; j < kids.length; j++) {
        const n = kids[j];
        if (n.type === "comment" && isBanner(n)) break; // next section
        if (n.type === "rule" || n.type === "atrule") {
          sawRule = true;
          if (!removed.has(n)) {
            sawSurvivor = true;
            break;
          }
        }
      }
      if (sawRule && !sawSurvivor) {
        removed.add(c);
        removedComments++;
      }
    }
  }

  // Apply (children precede parents in insertion order → no detach hazard).
  for (const n of removed) if (n.parent) n.remove();

  const out = root.toString();

  // ── Report ──────────────────────────────────────────────────────────────────
  const lineDelta = css.split("\n").length - out.split("\n").length;
  console.log(`dead target classes (${deadClasses.length}): ${deadClasses.join(", ")}`);
  console.log(`live target classes (${liveClasses.length}): ${liveClasses.join(", ")}`);
  console.log("");
  console.log(`rules removed:      ${removedRules}`);
  console.log(`rules selector-trimmed: ${edits.length}`);
  for (const e of edits)
    console.log(`    - "${e.before.replace(/\s+/g, " ").trim()}"\n   →  "${e.after.replace(/\s+/g, " ").trim()}"`);
  console.log(`@keyframes removed: ${removedKeyframes.length}${removedKeyframes.length ? ` (${removedKeyframes.join(", ")})` : ""}`);
  console.log(`comments removed:   ${removedComments}`);
  console.log(`lines: ${css.split("\n").length} → ${out.split("\n").length}  (−${lineDelta})`);

  if (DRY) {
    console.log("\n[--dry] no file written.");
    return;
  }
  writeFileSync(CSS_PATH, out);
  console.log(`\nwrote ${CSS_PATH}`);
}

main();
