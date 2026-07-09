# Inference benchmark harness

Reproducible before/after measurement of the local-LLM pipeline (vision + summarization),
so model/engine/config changes can be proven — not guessed. Design rationale and the
research behind it: `docs/superpowers/specs/2026-06-07-inference-perf-design.md` (local-only).

## What it measures

For each **config × fixture** it runs `warmup` discarded runs then `runs` measured runs and records:

- **Wall-clock** per run.
- **Ollama's own timings** (`load_duration`, `prompt_eval_*`, `eval_*`) → **prompt tok/s** and
  **generation tok/s**. Generation tok/s is the primary metric — it's independent of output length,
  so it's the fair way to compare models that produce different amounts of text.
- **Memory pressure** (free %, llama-server RSS) — the 17 GB model + 32 K KV cache on 36 GB is the
  suspected bottleneck.
- The model's **actual output**, captured for side-by-side quality review.

It does this by importing the **real** `OllamaVisionAnalyzer` and `OllamaSummarizer` and injecting a
capturing HTTP transport (`capture.ts`) — so it exercises the exact production request path with **no
production code changes**.

## Configs (`configs.ts`)

| Config      | Vision           | Summary    | Server state      |
|-------------|------------------|------------|-------------------|
| `baseline`  | gemma4:26b       | gemma4:26b | default           |
| `vision-7b` | qwen2.5vl (7B)   | gemma4:26b | default           |
| `tuned`     | gemma4:26b       | gemma4:26b | flash-attn + KV q8_0 |
| `combined`  | qwen2.5vl (7B)   | gemma4:26b | flash-attn + KV q8_0 |

Summarization stays on gemma4:26b in every config — Hebrew-quality risk is highest there, so we tune
memory rather than swap it.

## Running

```bash
# 1. Generate neutral, license-free fixtures (idempotent; needs ffmpeg).
make bench-fixtures

# 2. Headline comparison against the CURRENTLY running Ollama (no daemon restart):
make bench                       # baseline vs vision-7b, defaults: warmup=1 runs=2
make bench ARGS="--runs 3"       # more samples
make bench ARGS="--configs baseline"

# 3. Full four-config sweep INCLUDING the flash-attn/KV-q8_0 server states.
#    NOTE: restarts the Ollama server twice — momentarily stops the desktop app.
make bench-all
```

Outputs land in `bench/results/` (gitignored): a `*-results.json` (raw) and a `*-report.md`
(human-readable: headline table, per-stage tok/s, cold-load, memory, quality appendix).

## Fixtures & privacy

Committed fixtures are **neutral/synthetic**: ffmpeg-generated images + a short Game-of-Life video
(`fixtures/generate.sh`), and a **fully fictional** Hebrew chat (`fixtures/chat-he.json`, fed through
the real `buildPrompt`). No private data is committed.

⚠️ **Synthetic patterns do not test Hebrew OCR.** To judge whether a vision-model swap regresses
real caption/OCR quality, drop real media into `bench/fixtures/local/` (gitignored) and run with:

```bash
BENCH_FIXTURES_DIR=bench/fixtures/local make bench
```

## Type-checking

The harness is excluded from the production build (`tsconfig.json` `rootDir` is `src`). Type-check it
with its own config:

```bash
npx tsc -p bench/tsconfig.json
```
