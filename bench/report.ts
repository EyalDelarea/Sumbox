/**
 * Render a Markdown report from benchmark results: headline speed table, per-stage
 * tok/s, cold-load cost, memory pressure, and a side-by-side quality appendix.
 *
 * Primary metric is generation tok/s (intrinsic, output-length-independent). Wall time
 * and Δ% are reported too, with the `baseline` config as the reference. All percentages
 * are wall-time improvements (negative = slower).
 */
import type { ConfigResult, FixtureResult } from "./run.js";
import type { SysInfo } from "./sysinfo.js";

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const fNum = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const sec = (ms: number) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "—");

/** Median wall time (ms) for one fixture's measured runs. */
const fixtureWallMs = (f: FixtureResult) => median(f.runs.map((r) => r.wallMs));
/** Median generation tok/s for one fixture's measured runs. */
const fixtureGenTps = (f: FixtureResult) =>
  median(f.runs.map((r) => r.timings?.gen_tok_s ?? Number.NaN).filter(Number.isFinite));

const STAGES: FixtureResult["stage"][] = ["image", "video", "summary"];

function pct(now: number, base: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(base) || base === 0) return "—";
  const delta = ((base - now) / base) * 100; // positive = faster than baseline
  const sign = delta >= 0 ? "" : "+";
  return `${sign}${(-delta).toFixed(0)}%`.replace("-", "−"); // negative shown as faster
}

/** Faster-than-baseline as a clean "x.x× / N% faster" string for the headline. */
function speedup(base: number, now: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(base) || now === 0) return "—";
  const x = base / now;
  if (x >= 1) return `${x.toFixed(2)}× (${(((base - now) / base) * 100).toFixed(0)}% faster)`;
  return `${x.toFixed(2)}× (${(((now - base) / base) * 100).toFixed(0)}% slower)`;
}

export function writeReport(sys: SysInfo, results: ConfigResult[]): string {
  const L: string[] = [];
  const baseline = results.find((r) => r.config.name === "baseline") ?? results[0];

  L.push("# Inference Benchmark Results", "");
  L.push(
    `**Machine:** ${sys.chip ?? "?"} · ${sys.ramGb ?? "?"} GB · ${sys.gpuCores ?? "?"}-core GPU · macOS ${sys.macos ?? "?"} · Ollama ${sys.ollamaVersion ?? "?"}`,
  );
  L.push(`**Captured:** ${sys.capturedAt}  ·  **Server config:** \`${sys.serverConfig}\``);
  L.push(`**Reference (baseline):** \`${baseline.config.name}\``, "");

  // ---- Headline: total wall time per config ----
  L.push("## Headline — total wall time (sum of per-fixture medians)", "");
  L.push("| Config | Vision model | Summary model | Total median wall | vs baseline |");
  L.push("|---|---|---|---:|---|");
  const totalWall = (r: ConfigResult) => r.fixtures.reduce((a, f) => a + fixtureWallMs(f), 0);
  const baseTotal = totalWall(baseline);
  for (const r of results) {
    const tw = totalWall(r);
    L.push(
      `| \`${r.config.name}\` | ${r.config.visionModel} | ${r.config.summaryModel} | ${sec(tw)}s | ${
        r === baseline ? "—" : speedup(baseTotal, tw)
      } |`,
    );
  }
  L.push("");

  // ---- Per-stage: gen tok/s + wall + Δ ----
  for (const stage of STAGES) {
    const hasStage = results.some((r) => r.fixtures.some((f) => f.stage === stage));
    if (!hasStage) continue;
    L.push(`## ${stage[0].toUpperCase()}${stage.slice(1)} stage`, "");
    L.push("| Config | Median gen tok/s | Median wall (per fixture) | Δ wall vs baseline |");
    L.push("|---|---:|---:|---|");
    const baseStageWall = mean(
      baseline.fixtures.filter((f) => f.stage === stage).map((f) => fixtureWallMs(f)),
    );
    for (const r of results) {
      const fs = r.fixtures.filter((f) => f.stage === stage);
      if (fs.length === 0) continue;
      const tps = mean(fs.map((f) => fixtureGenTps(f)));
      const wall = mean(fs.map((f) => fixtureWallMs(f)));
      L.push(
        `| \`${r.config.name}\` | ${fNum(tps)} | ${sec(wall)}s | ${
          r === baseline ? "—" : pct(wall, baseStageWall)
        } |`,
      );
    }
    L.push("");
  }

  // ---- Cold-load (first warmup per stage) ----
  L.push("## Cold-load cost (first warmup wall per stage)", "");
  L.push("_First call after a model switch pays load_duration; steady-state runs above do not._", "");
  L.push("| Config | image | video | summary |");
  L.push("|---|---:|---:|");
  for (const r of results) {
    const cold = (stage: FixtureResult["stage"]) => {
      const f = r.fixtures.find((x) => x.stage === stage);
      return f?.warmupMs.length ? `${sec(f.warmupMs[0])}s` : "—";
    };
    L.push(`| \`${r.config.name}\` | ${cold("image")} | ${cold("video")} | ${cold("summary")} |`);
  }
  L.push("");

  // ---- Memory pressure ----
  L.push("## Memory pressure", "");
  L.push("| Config | Min free % observed | Max llama-server RSS |");
  L.push("|---|---:|---:|");
  for (const r of results) {
    const free = r.fixtures.flatMap((f) => f.runs.map((x) => x.freePctAfter ?? Number.NaN)).filter(Number.isFinite);
    const rss = r.fixtures.flatMap((f) => f.runs.map((x) => x.llamaServerRssMb ?? Number.NaN)).filter(Number.isFinite);
    const minFree = free.length ? `${Math.min(...free)}%` : "—";
    const maxRss = rss.length ? `${(Math.max(...rss) / 1024).toFixed(1)} GB` : "—";
    L.push(`| \`${r.config.name}\` | ${minFree} | ${maxRss} |`);
  }
  L.push("");

  // ---- Quality appendix ----
  L.push("## Quality appendix — actual model output (same input, each config)", "");
  L.push(
    "_Synthetic ffmpeg fixtures do NOT test Hebrew OCR. For a real quality verdict on a model",
    "swap, re-run with `BENCH_FIXTURES_DIR` pointed at real media in `bench/fixtures/local/`._",
    "",
  );
  const fixtureNames = [...new Set(results.flatMap((r) => r.fixtures.map((f) => f.fixture)))];
  for (const name of fixtureNames) {
    L.push(`### ${name}`, "");
    for (const r of results) {
      const f = r.fixtures.find((x) => x.fixture === name);
      if (!f) continue;
      L.push(`**\`${r.config.name}\`** (${f.stage === "summary" ? r.config.summaryModel : r.config.visionModel}):`, "");
      L.push("```", (f.sampleOutput || "(empty)").trim(), "```", "");
    }
  }

  return L.join("\n");
}
