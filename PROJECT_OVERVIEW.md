# Sumbox — Project Overview (for agent collaboration / brainstorming)

> **Purpose of this document:** a single, self-contained briefing on what Sumbox
> *is*, what it *does*, and what already exists (functionality + tooling), so another
> agent can use it as a grounding source for product ideation.

---

## 1. One-line summary

**Sumbox** is a **local, single-user personal WhatsApp summarizer** — a fun
side project, not a hosted product. You wake up to 200 unread messages;
Sumbox reads them for you — overnight, on your own machine — so you open
your phone to *the gist*, not the scroll. **Nothing leaves your machine**
except the read-only WhatsApp link itself. No cloud API keys, no hosted
service, no data sharing, no login.

---

## 2. Core value proposition

- **The product is the summary.** Everything else (collection, transcription,
  vision, queueing) is plumbing in service of producing a high-quality,
  structured "what I missed" summary of a WhatsApp group.
- **Privacy is a hard constraint, not a feature.** All inference (LLM
  summarization, speech-to-text, image/video captioning) runs locally via
  Ollama + faster-whisper. Message content never leaves the device.
- **Hebrew is first-class.** Transcription, OCR, and summaries all target
  Hebrew (RTL UI, Hebrew Whisper model, Hebrew-capable vision/LLM). The system
  must not assume English.
- **Mobile-first consumption.** The output is a mobile web app, RTL, designed
  to be opened on your phone over LAN.

---

## 3. How it works (end-to-end pipeline)

```
WhatsApp ──(Baileys, read-only live link)──┐
                                           ├─► normalize + dedupe ─► PostgreSQL (source of truth)
WhatsApp export (.txt/.zip) ──(importer)───┘                              │
                                                                          ├─► faster-whisper (voice notes → Hebrew transcripts)
                                                                          ├─► Ollama vision (images/video → Hebrew captions + OCR)
                                                                          │
                                                            transcripts + captions + text
                                                                          │
                                                                          ▼
                                                          Ollama LLM (structured Hebrew summary)
                                                                          │
                                                          ┌───────────────┼───────────────┐
                                                          ▼               ▼               ▼
                                                     Web UI (mobile)   CLI output   scheduled digest
```

- **Postgres is the sole source of truth.** The message broker (RabbitMQ)
  carries only job *references* (IDs), never message content.
- **Two ingestion paths, one schema.** The export importer and the live
  Baileys collector both normalize into the *same* `messages` table. Dedup is
  an explicit documented contract (exports lack stable IDs).
- **Single-threaded worker by default** (`WORKER_CONCURRENCY=1`): summaries
  and vision share one Ollama model residency and run serially.

---

## 4. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 22, TypeScript, ES modules |
| Storage | PostgreSQL (sole persistent store); media/exports on disk under `data/` |
| Live collection | [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp lib), hardened read-only |
| LLM (summaries) | **Local Ollama**, default `gemma4:26b`, ~32k context |
| Vision (images/video) | Local Ollama vision, default `gemma4:26b` (multi-frame video) |
| Speech-to-text | Python `faster-whisper`, model `ivrit-ai/whisper-large-v3-turbo-ct2` (Hebrew) |
| Job queue | RabbitMQ (competing consumers, retries, dead-letter) |
| Web front-end | Vanilla JS/HTML/CSS (no framework), mobile-first, RTL, SSE streaming |
| Media tooling | ffmpeg (audio normalization + video frame extraction) |
| Infra | Docker Compose (Postgres, RabbitMQ); the app runs on the host for CPU/GPU access |
| Tests | Vitest + Testcontainers (ephemeral Postgres & RabbitMQ) |
| Lint/format | Biome |

---

## 5. CLI surface (`npx tsx src/cli.ts <command>`)

| Command | What it does |
|---|---|
| `serve [--port N] [--collect]` | Start the mobile web UI (default :8787). `--collect` also runs the live collector; the digest scheduler also starts here. |
| `collect` | Standalone live collector (QR link on first run), stores incoming group messages. |
| `summarize <name> [--last N] [--since DATE] [--out file]` | Generate a structured Hebrew summary of a chat from the CLI. |
| `groups` | List all stored groups/chats with source + message counts. |
| `transcribe [--group name]` | Run faster-whisper on pending (untranscribed) voice notes. |
| `analyze-backlog [--limit N] [--types ...]` | Enqueue vision analysis (`analyze.image`/`analyze.video`) for media lacking a completed analysis. |
| `digest-run [--all]` | Manually trigger the scheduled digest (enqueues `summarize.group` jobs). |
| `ops-sweep` | Ops maintenance: self-heal dead jobs, record status history. |
| `import <file> [--name N] [--folder dir]` | Import a WhatsApp export (`.txt`/`.zip`); dedupes; `--folder` for bulk. |
| `media-backfill [--limit N]` | Download + analyze media descriptors stored at ingest but not yet fetched. |
| `full-sync` | Pull deep WhatsApp history on a freshly-linked session (onboarding push sync). |
| `merge-duplicate-chats` | Merge duplicate group rows (e.g. LID/PN identity splits) into one. |
| `doctor` | Verify prerequisites (Docker, compose, Postgres+migrations, RabbitMQ, Ollama+model, faster-whisper, ffmpeg). |

`make dev` is the everyday entry point: brings up the Docker stack, applies
migrations, and starts the worker + web server + live collector together.

---

## 6. Web UI surfaces

The web app (`src/web/public/`) has three surfaces:

| Surface | Hebrew label | What it does |
|---|---|---|
| `sumbox` | עדכונים (updates) | The landing view — the feed of per-chat and total summaries. |
| `sources` | צ׳אטים (chats) | Pick which chats feed summaries. |
| `commands` | פקודות (commands) | Manage the in-chat `/סיכום` command — which groups it's enabled for and its trigger word. |

---

## 7. Key subsystems (where things live in `src/`)

| Dir | Responsibility |
|---|---|
| `collector/` | Baileys live collector, message mapping, name resolution, **outbound-guard** (hardened so it can never send), backfill, session. |
| `importer/` | WhatsApp `.txt`/`.zip` parsing, normalization, dedupe, bulk import, media extraction. |
| `db/` | Postgres client, migrations, repositories (groups, messages, summaries, transcripts, media-analyses, job-runs, watermarks, scheduler-state, status-snapshots, chat-scopes, service-status). The schema still carries inert `tenant_id` columns and a single-row `tenants` table from a removed multi-tenancy design; the app has no tenant concept and connects as the DB owner. See `CLAUDE.md`. |
| `serve/` | The `serve` composition root — wires the collector, scheduler, retention sweep, and web server into one process. |
| `test/` | Shared Vitest harness: one Postgres container, per-file isolated DB clones. |
| `jobs/` | Job bus abstraction — in-memory bus (tests) + RabbitMQ bus (prod), job types, run recorder. |
| `workers/` | Worker process + handlers: `import-file`, `transcribe-voicenote`, `analyze-media`, `summarize-group`, `summarize-total`. |
| `transcription/` | Python `faster-whisper` worker (`worker.py`), Node wrapper, ivrit-whisper integration. |
| `vision/` | Ollama image/video analyzer, media-kind detection, multi-frame video analysis. |
| `summarization/` | Selection, catch-up prep, prompt assembly, Ollama summarizer, rendering. |
| `scheduler/` | Twice-daily digest scheduler (pre-summaries), enqueue-run, runner, schedule logic. |
| `service/` | Always-on service: heartbeat, liveness, status. |
| `ops/` | Operational tooling: `sweep` (self-heal dead jobs), `redrive` (re-queue failures). |
| `media/` | Prune-after-caption (delete media files after analysis unless `RETAIN_MEDIA=true`). |
| `doctor/` | Prerequisite checks. |
| `web/` | HTTP server, SSE (streaming summaries), static mobile UI under `public/` (vanilla JS libs: api, health, markdown, open-state, progress, time). |
| `logging/` | pino logger (stdout only). |

---

## 8. Observability & ops

- **App status API** (http://localhost:8787/api/status).
- **RabbitMQ management** (http://localhost:15672, guest/guest).
- **Self-healing**: `ops-sweep` redrives/reaps dead jobs; status snapshots give
  an observable history.
- Logs are plain pino JSON to stdout — pipe through `pino-pretty` (wired into
  `make dev` / `scripts/dev-common.sh`) for readable local output.

---

## 9. Privacy & safety posture

- **100% local inference.** The only network touch is the read-only WhatsApp
  link.
- **Outbound hardening.** `sendMessage`/`relayMessage` throw; presence, read
  receipts, typing indicators are silenced to no-ops. Cannot be accidentally
  bypassed. Sending requires explicit `WHATSAPP_ALLOW_SEND=true`.
- **Media pruning.** Media files are deleted after captioning by default
  (`RETAIN_MEDIA=false`).
- **Unofficial library disclaimer.** Baileys is reverse-engineered; not
  affiliated with WhatsApp/Meta; personal use only, at your own risk.

---

## 10. Known gaps / backlog (opportunity surface for new ideas)

- **Import ↔ live group merge:** imported groups have no WhatsApp JID, so the
  live collector creates a *separate* row for the same real group → stale
  cache when summarizing. Needs a manual "link group A ↔ B" action + UI
  surface.
- **Summary quality** is the open frontier: better Hebrew, topic threading,
  model choice (quality vs. speed), evaluation. Length scaling is currently
  prompt-guidance only.
- **Media analysis quality WIP:** earlier vision model had preamble leakage +
  degeneration on text-heavy Hebrew images; re-enabled with gemma4:26b but
  quality tuning continues.
- **Hebrew name overrides** (deferred); `@lid` opaque IDs can't always resolve
  to a name.
- **Ultra-short-video frame extraction** (deferred): sub-second clips break
  `fps=1` extraction → should grab 1 frame.
- **No packaged deploy / prod story:** day-to-day is `make dev`.
- **Off-LAN / true PWA** (optional, infra-leaning): needs HTTPS (mkcert) or
  Tailscale; deliberately HTTP-only today.
- **Memory tuning:** summary + vision models co-resident is tight on a 36 GB
  Mac.

---

## 11. Quick repo facts

- TypeScript, single repo. Started as a fork of the open-source
  `EyalDelarea/Catchup`.
- CI on GitHub-hosted `ubuntu-latest` runners (`.github/workflows/ci.yml`),
  which ship Docker for Testcontainers.
- **Entry points:** `make dev` (everything) · `src/cli.ts` (CLI) ·
  `src/web/server.ts` (UI) · `src/workers/worker.ts` (jobs).
- **Default ports:** Web 8787 · Postgres 5432 · RabbitMQ 5672/15672.
