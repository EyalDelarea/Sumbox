/**
 * Inference benchmark harness.
 *
 * Measures the REAL production request path by importing OllamaVisionAnalyzer and
 * OllamaSummarizer and injecting a capturing transport (bench/capture.ts) that records
 * Ollama's timing fields. For each config × fixture it runs `warmup` discarded runs then
 * `runs` measured runs, recording wall-clock, Ollama tok/s, memory pressure, and the
 * model's actual output (for side-by-side quality review).
 *
 * Usage (via `make bench` or directly):
 *   npx tsx bench/run.ts --configs baseline,vision-7b --server-config default --runs 2
 *
 * Flags:
 *   --configs <csv|all>     configs to run (default: all). See bench/configs.ts.
 *   --server-config <label> label for the active Ollama server state (default: "default").
 *   --warmup <n>            discarded warmup runs per fixture (default: 1).
 *   --runs <n>              measured runs per fixture (default: 2).
 *   --host <url>            Ollama host (default: $OLLAMA_HOST or http://localhost:11434).
 *   --tag <label>          filename tag for the output files.
 *
 * Fixtures: images + one video from bench/fixtures/generated (or $BENCH_FIXTURES_DIR for
 * real local media), plus the synthetic Hebrew chat at bench/fixtures/chat-he.json.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SelectedMessage } from "../src/summarization/select.js";
import { buildPrompt } from "../src/summarization/prompt.js";
import { OllamaSummarizer } from "../src/summarization/summarizer.js";
import { OllamaVisionAnalyzer } from "../src/vision/ollama-analyzer.js";
import { makeCapture, type OllamaTimings } from "./capture.js";
import { type BenchConfig, resolveConfigs } from "./configs.js";
import { writeReport } from "./report.js";
import { captureSysInfo, sampleMemory } from "./sysinfo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);

type RunRecord = {
  wallMs: number;
  timings?: OllamaTimings;
  freePctAfter?: number;
  llamaServerRssMb?: number;
};

export type FixtureResult = {
  fixture: string;
  stage: "image" | "video" | "summary";
  warmupMs: number[];
  runs: RunRecord[];
  sampleOutput: string;
};

export type ConfigResult = {
  config: BenchConfig;
  fixtures: FixtureResult[];
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

/** Replicate production frame extraction: fps sampling, capped frame count. */
function extractFrames(videoPath: string, fps: number, maxFrames: number, outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  execFileSync(
    ffmpeg,
    ["-y", "-loglevel", "error", "-i", videoPath, "-vf", `fps=${fps}`, path.join(outDir, "frame-%04d.jpg")],
    { timeout: 60_000 },
  );
  const frames = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .slice(0, maxFrames)
    .map((f) => path.join(outDir, f));
  if (frames.length === 0) throw new Error(`No frames extracted from ${videoPath}`);
  return frames;
}

function discoverFixtures(dir: string): { images: string[]; video?: string } {
  if (!fs.existsSync(dir)) {
    throw new Error(`Fixtures dir not found: ${dir}. Run: bash bench/fixtures/generate.sh`);
  }
  const entries = fs.readdirSync(dir).map((f) => path.join(dir, f));
  const images = entries.filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort();
  const video = entries.find((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()));
  return { images, video };
}

function loadChatPrompt() {
  const chatPath = path.join(HERE, "fixtures", "chat-he.json");
  const raw = JSON.parse(fs.readFileSync(chatPath, "utf8")) as {
    messages: { sentAt: string; sender: string; content: string }[];
  };
  const messages = raw.messages.map(
    (m) => ({ sentAt: new Date(m.sentAt), sender: m.sender, content: m.content }) as unknown as SelectedMessage,
  );
  return buildPrompt(messages);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timeOnce(fn: () => Promise<string>): Promise<{ wallMs: number; output: string }> {
  const t0 = performance.now();
  const output = await fn();
  return { wallMs: performance.now() - t0, output };
}

async function runFixture(
  label: string,
  stage: FixtureResult["stage"],
  call: () => Promise<string>,
  takeLast: () => OllamaTimings | undefined,
  warmup: number,
  runs: number,
): Promise<FixtureResult> {
  const warmupMs: number[] = [];
  for (let i = 0; i < warmup; i++) {
    const { wallMs } = await timeOnce(call);
    warmupMs.push(Math.round(wallMs));
    process.stderr.write(`    warmup ${i + 1}/${warmup}: ${Math.round(wallMs)}ms\n`);
  }
  const recs: RunRecord[] = [];
  let sampleOutput = "";
  for (let i = 0; i < runs; i++) {
    const { wallMs, output } = await timeOnce(call);
    const mem = sampleMemory();
    const timings = takeLast();
    if (i === 0) sampleOutput = output;
    recs.push({
      wallMs: Math.round(wallMs),
      timings,
      freePctAfter: mem.freePct,
      llamaServerRssMb: mem.llamaServerRssMb,
    });
    const tps = timings?.gen_tok_s ? `${timings.gen_tok_s.toFixed(1)} tok/s` : "n/a";
    process.stderr.write(`    run ${i + 1}/${runs}: ${Math.round(wallMs)}ms  gen=${tps}\n`);
    await sleep(500); // small settle between runs
  }
  return { fixture: label, stage, warmupMs, runs: recs, sampleOutput };
}

async function runConfig(
  config: BenchConfig,
  host: string,
  fixturesDir: string,
  warmup: number,
  runs: number,
): Promise<ConfigResult> {
  process.stderr.write(`\n=== Config: ${config.name} ===\n  ${config.description}\n`);
  const cap = makeCapture();
  const vision = new OllamaVisionAnalyzer({
    host,
    model: config.visionModel,
    numCtx: config.visionNumCtx,
    fetchFn: cap.visionFetch,
  });
  const summarizer = new OllamaSummarizer({
    host,
    model: config.summaryModel,
    numCtx: config.summaryNumCtx,
    fetchImpl: cap.summaryFetch,
  });

  const { images, video } = discoverFixtures(fixturesDir);
  const fixtures: FixtureResult[] = [];

  for (const img of images) {
    process.stderr.write(`\n  [image] ${path.basename(img)} (${config.visionModel})\n`);
    fixtures.push(
      await runFixture(
        path.basename(img),
        "image",
        async () => (await vision.describeImage(img)).description,
        cap.takeLast,
        warmup,
        runs,
      ),
    );
  }

  if (video) {
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-frames-"));
    try {
      const frames = extractFrames(video, 1, 8, frameDir);
      const label = `${path.basename(video)} (${frames.length} frames)`;
      process.stderr.write(`\n  [video] ${label} (${config.visionModel})\n`);
      fixtures.push(
        await runFixture(
          label,
          "video",
          async () => (await vision.describeImages(frames)).description,
          cap.takeLast,
          warmup,
          runs,
        ),
      );
    } finally {
      fs.rmSync(frameDir, { recursive: true, force: true });
    }
  }

  const prompt = loadChatPrompt();
  process.stderr.write(`\n  [summary] chat-he.json (${config.summaryModel}, num_ctx=${config.summaryNumCtx})\n`);
  fixtures.push(
    await runFixture(
      "chat-he.json",
      "summary",
      async () => (await summarizer.summarize(prompt)).overview,
      cap.takeLast,
      warmup,
      runs,
    ),
  );

  return { config, fixtures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const serverConfig = args["server-config"] ?? "default";
  const warmup = Number(args.warmup ?? 1);
  const runs = Number(args.runs ?? 2);
  const fixturesDir = process.env.BENCH_FIXTURES_DIR ?? path.join(HERE, "fixtures", "generated");
  const outDir = args.out ?? path.join(HERE, "results");
  const configs = resolveConfigs(args.configs);

  // Fail fast if Ollama is unreachable.
  try {
    const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama not reachable at ${host} (${m}). Start it and retry.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tag = args.tag ? `-${args.tag}` : "";
  const sys = captureSysInfo(serverConfig, new Date().toISOString());

  process.stderr.write(
    `Benchmark @ ${stamp}\n  host=${host} server-config=${serverConfig} warmup=${warmup} runs=${runs}\n` +
      `  machine=${sys.chip} ${sys.ramGb}GB ${sys.gpuCores}-core GPU, Ollama ${sys.ollamaVersion}\n` +
      `  fixtures=${fixturesDir}\n  configs=${configs.map((c) => c.name).join(", ")}\n`,
  );

  const results: ConfigResult[] = [];
  for (const c of configs) {
    results.push(await runConfig(c, host, fixturesDir, warmup, runs));
  }

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${stamp}${tag}-results.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ sys, results }, null, 2));
  const reportPath = path.join(outDir, `${stamp}${tag}-report.md`);
  fs.writeFileSync(reportPath, writeReport(sys, results));

  process.stderr.write(`\nWrote:\n  ${jsonPath}\n  ${reportPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nBenchmark failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
