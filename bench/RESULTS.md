# Inference Benchmark — Results & Recommendation

**Machine:** Apple M3 Pro · 36 GB · 14-core GPU · macOS 26.5 · Ollama 0.30.4
**Date:** 2026-06-07 · **Method:** `make bench` (warmup=1, median of 2 measured runs, real
production request path via `OllamaVisionAnalyzer`/`OllamaSummarizer`). Raw data and the full
per-fixture report are in `bench/results/` (gitignored).

## TL;DR — keep the current config; the proposed swap is a regression

We benchmarked the research-recommended optimization (swap the vision model from `gemma4:26b`
to the smaller, already-installed `qwen2.5vl` 7B) against the current production setup. **On this
hardware it is slower *and* lower quality.** No config change is warranted. The harness paid for
itself by preventing a regression.

| Config | Vision | Summary | Total wall | vs baseline |
|---|---|---|---:|---|
| **`baseline`** (production) | gemma4:26b | gemma4:26b | **41.4s** | — |
| `vision-7b` (proposed swap) | qwen2.5vl 7B | gemma4:26b | 55.3s | **0.75× (34% slower)** |

## Why the generic advice failed here

The deep-research recommendation assumed a **bandwidth-bound dense 27B**. Measurement shows
`gemma4:26b` generates at **~34 tok/s** on a ~150 GB/s machine — impossible for a dense 25.8B model
(that would need ~560 GB/s), so it is effectively an **MoE with ~5B active params**: already fast and
well-suited to this box. The "swap to a smaller model" lever assumed a problem this pipeline does
not have. Meanwhile `qwen2.5vl` 7B is *dense* and its multi-frame image prefill is much slower.

## Speed detail (generation tok/s + wall time)

| Stage | baseline (gemma4:26b) | vision-7b (qwen2.5vl) | Verdict |
|---|---|---|---|
| Image | 34.2 tok/s · 5.6s | 24.1 tok/s · 5.0s | gemma ~40% faster generation |
| **Video (6 frames)** | 34.9 tok/s · **3.3s** | 23.1 tok/s · **22.6s** | **gemma ~7× faster** |
| Summary (both gemma4:26b) | 33.1 tok/s · 21.2s | 34.8 tok/s · 17.9s | unchanged (same model) |

Memory was effectively identical (~18 GB resident, ~24–25% free) — the swap buys no headroom either.

## Quality (the decisive factor)

Even on synthetic fixtures, `qwen2.5vl` Hebrew is badly degraded; `gemma4:26b` is clean and accurate.
Representative failures from `qwen2.5vl`:

- **Code-switching into English mid-sentence:** `דOTS`, `stripes`, `Strip`, `Test Pattern`.
- **Invented non-words:** `סגול עזבוק`, `אפריקן`, `encentrum`.
- **Repetition collapse on video:** the same paragraph repeated ~8× until truncated at `num_predict`.

`gemma4:26b`, same inputs — fluent and correct (full side-by-side in the per-run report under
`bench/results/`). This matches the long-standing note in `.env.example` that gemma4 has better
Hebrew OCR/description than qwen2.5vl — now backed by data.

> ⚠️ Fixtures are synthetic ffmpeg patterns and do **not** exercise real Hebrew OCR. The quality gap
> is already obvious here; on real photos it would be larger. To re-confirm on real media, drop files
> into `bench/fixtures/local/` and run `BENCH_FIXTURES_DIR=bench/fixtures/local make bench`.

## Where time actually goes — and the real levers

1. **Cold-load dominates latency**, not steady-state generation: summary first call **33s** vs **~20s**
   warm; vision first call 7–16s vs 3–6s warm. Production already mitigates this well — it uses **one
   shared model** (`gemma4:26b` for both vision and summary, so nothing thrashes in/out) plus
   `keep_alive`. *Do not* split into two models: that would add a second resident model competing for
   the 36 GB and reintroduce reload thrash.
2. **Scheduled digests (twice daily) likely run cold** — the 10-minute `keep_alive` expires between
   runs, so each scheduled/first-open digest pays the ~33s load. A cheap pre-warm ping before the
   scheduled window (or a longer `keep_alive`) would cut user-visible latency. *(Recommended follow-up;
   not applied here — it's a behavior change beyond this benchmarking PR.)*
3. **Flash Attention is already on** (`llama-server … --flash-attn auto`). The one remaining server
   knob is **KV-cache quantization** (`OLLAMA_KV_CACHE_TYPE=q8_0`), which mainly trades a little
   quality headroom for memory on the 32K-ctx summary. Memory is currently healthy (~24% free), so
   this is **low priority**. It requires restarting the Ollama server, so it's left as an opt-in sweep:
   `make bench-all` (restarts Ollama; relaunch Ollama.app after).

## Decision

- **No change to `VISION_MODEL` / `SUMMARY_MODEL`.** `gemma4:26b` stays for both — fastest and best
  Hebrew on this hardware.
- Comment added to `.env.example` recording this benchmark so the swap isn't naively re-attempted.
- Optional, lower-priority follow-ups (pre-warm for scheduled digests; KV-cache-quant sweep) are
  documented above with ready-to-run commands.
