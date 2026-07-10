<p align="center">
  <img src="assets/banner.png" alt="Sumbox — local-first WhatsApp summaries" width="720" />
</p>

<p align="center">
  <a href="#-requirements"><img src="https://img.shields.io/badge/node-%E2%89%A522-3c873a?logo=node.js&logoColor=white" alt="Node ≥ 22" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-8A2BE2" alt="Apache 2.0" /></a>
  <a href="https://github.com/EyalDelarea/Sumbox/actions/workflows/ci.yml"><img src="https://github.com/EyalDelarea/Sumbox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/privacy-100%25%20local-0ea5e9" alt="100% local" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

# 🧊 Sumbox

> 📨 **Wake up to 200 unread messages?** Sumbox reads them for you — overnight, locally — so you open your phone to *the gist*, not the scroll.

A **local, single-user** WhatsApp summarizer, built for fun. Messages are collected passively via a read-only linked device (using [Baileys](https://github.com/WhiskeySockets/Baileys)), stored in your own Postgres, transcribed locally (faster-whisper), captioned locally (Ollama vision), and summarized locally (Ollama) — then displayed in a mobile-first, RTL Hebrew web UI. **Nothing leaves your machine.** No cloud API keys, no hosted service, no login, no data sharing.

<p align="center">
  <img src="assets/screens/desktop.png" alt="Sumbox web UI — a chat's structured Hebrew catch-up summary (תקציר · נושאים עיקריים · החלטות ומשימות · שאלות פתוחות) beside the sage-green nav rail" width="820" />
</p>

<p align="center"><sub>📊 The web UI — a chat's structured catch-up summary: TL;DR, key topics, decisions & tasks, open questions. Demo data shown.</sub></p>

---

## ✨ How it works

```mermaid
flowchart LR
    WA["📲 WhatsApp<br/>Baileys · read-only"] --> PG[("🗄️ Postgres<br/>your database")]
    PG --> W["🎙️ Whisper<br/>voice → text"]
    PG --> V["👁️ Ollama vision<br/>images/video → captions"]
    W --> S["🧠 Ollama<br/>structured summary"]
    V --> S
    S --> UI["📱 Web UI<br/>mobile · RTL · Hebrew"]
```

Every box runs on **your machine**. The only thing that touches the network is the read-only WhatsApp link itself.

The web UI has three surfaces: **עדכונים** (updates — the summaries feed, the landing view), **צ׳אטים** (chats — pick which chats feed summaries), and **פקודות** (commands — manage the in-chat `/סיכום` command).

### 📊 Total summary (סיכום כללי)

In addition to per-chat summaries, Sumbox can produce a single digest across **all** your chats at once. It summarizes each active group and DM for the chosen time range, then reduces those into cross-cutting highlights — flagging things that need your attention — followed by a per-chat breakdown.

- **On demand in the web UI:** a pinned "📊 סיכום כללי" card sits at the top of the chat list; pick a range (24 h / 3 days / week) and the summary streams in live.
- **Automatically:** the twice-daily scheduler produces a total summary alongside the per-chat digests, so it's ready when you wake up.

### 💬 `/סיכום` — in-chat summary command

Type `/סיכום` in any WhatsApp group Sumbox is watching to get a summary posted back into that chat. The **פקודות** (commands) tab in the web UI controls which groups the command is enabled for and lets you change the trigger word.

---

## ⚠️ Disclaimer

Sumbox uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial**, reverse-engineered WhatsApp library. This project is **not affiliated with, endorsed by, or approved by WhatsApp or Meta**. Using unofficial clients may violate WhatsApp's Terms of Service. You are solely responsible for ensuring your use complies with applicable terms and laws. Use at your own risk, for personal use only.

---

## 📋 Requirements

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | `package.json` engines field (and `.nvmrc`, which CI reads) |
| Docker + Docker Compose v2 | any recent | `docker compose` (v2 syntax); runs Postgres + RabbitMQ |
| ffmpeg | any | On PATH; used for audio normalization and video frame extraction |
| Python | ≥ 3.10 | With `faster-whisper` installed (Hebrew voice-note transcription) |
| Ollama | any | Local LLM server; runs summaries and vision captioning |

### 🧠 RAM — the #1 gotcha

The default model (`gemma4:26b`) is used for both summaries and image/video captioning. It requires significant memory:

| Setup | Minimum RAM | Notes |
|---|---|---|
| `gemma4:26b` (default) | ~16 GB unified / ~26 GB system | Best quality; Hebrew OCR; multi-frame video |
| `gemma4:12b` | ~10 GB | Good quality; set `SUMMARY_MODEL=gemma4:12b` and `VISION_MODEL=gemma4:12b` |
| `gemma4:4b` | ~4 GB | Lighter; quality degrades for Hebrew |

To use a smaller model, set `SUMMARY_MODEL` and/or `VISION_MODEL` in your `.env`:

```bash
SUMMARY_MODEL=gemma4:12b
VISION_MODEL=gemma4:12b
VISION_VIDEO_MODEL=gemma4:12b
```

Both summaries and vision run on the same Ollama instance. The worker is single-threaded by default (`WORKER_CONCURRENCY=1`), so they run serially and share one model residency.

---

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/EyalDelarea/Sumbox.git
cd Sumbox
npm install

# 2. Configure (all keys have sane defaults)
cp .env.example .env

# 3. Pull the Ollama model (needs Ollama: https://ollama.com)
ollama pull gemma4:26b

# 4. Start everything (provisions the transcription venv on first run)
make dev

# 5. Open the web UI → http://localhost:8787
```

`make dev` brings up Postgres and RabbitMQ via Docker Compose; applies database migrations; **provisions the Python faster-whisper venv if it's missing** (so voice-note transcription works on first run); and starts the background worker and the web server + live collector together. Ctrl-C stops everything cleanly.

The transcription venv is created by `scripts/setup-python.sh` (run standalone with `make setup`). It picks a Python ≥ 3.10, installs `src/transcription/requirements.txt` into `.venv`, and points `TRANSCRIPTION_PYTHON` at it in `.env`. To use your own interpreter instead, set `TRANSCRIPTION_PYTHON` to one that has `faster-whisper` installed and setup will leave it alone.

---

## 🩺 Verify with `doctor`

Before linking WhatsApp, confirm all prerequisites pass:

```bash
npx tsx src/cli.ts doctor
```

The doctor checks, in order:

1. **Docker running** — `docker info` exits 0
2. **Compose services up** — at least one container is running
3. **Postgres reachable + migrations applied** — connects and verifies the `job_runs` and `service_status` tables exist
4. **RabbitMQ reachable** — opens and closes an AMQP connection
5. **Ollama reachable + model pulled** — hits `/api/tags` and checks that `SUMMARY_MODEL` is present
6. **Python + faster-whisper importable** — spawns `python -c "import faster_whisper"`
7. **ffmpeg on PATH** — spawns `ffmpeg -version`

Each line prints `✅ <check>`, `⚠️ <check>` (advisory — does not fail the run), or `❌ <check> — fix: <command>`. The process exits 1 only if a non-advisory check fails.

---

## 🔗 Linking WhatsApp (QR walkthrough)

This is the most important step. On first run (`make dev` or `npx tsx src/cli.ts serve --collect`), a QR code prints in the terminal.

**Before the QR appears, a safety banner prints:**

```
🔒 Read-only mode: this tool will NOT send messages, read receipts, or presence.
   It is a passive observer. (Sending stays off unless you set WHATSAPP_ALLOW_SEND=true.)
```

**To link:**

1. Open WhatsApp on your phone.
2. Tap the menu (three dots, top-right on Android) or **Settings** (bottom-right on iOS).
3. Tap **Linked Devices** → **Link a Device**.
4. Point your camera at the QR in the terminal.

**Tips:**
- The QR expires in about 20 seconds. If it expires, a new one is printed automatically.
- If the QR looks broken or garbled, maximize your terminal window and try again.
- Once linked, the session is saved to `data/baileys-auth/` and resumes automatically on restart — no re-scan needed.

**If you get logged out** (WhatsApp logs out linked devices after inactivity or if you unlink manually):

```bash
rm -rf data/baileys-auth/
# Then restart make dev or serve --collect — a new QR will print
```

**Outbound safety:** The linked device is hardened to never send anything. `sendMessage` and `relayMessage` throw if called. Presence updates, read receipts, and typing indicators are silenced to no-ops. This cannot be accidentally bypassed. To explicitly enable sending, set `WHATSAPP_ALLOW_SEND=true` in `.env`.

---

## 🛠️ CLI commands

<details>
<summary><strong>Expand the full command reference</strong> — serve, collect, summarize, groups, transcribe, analyze-backlog, digest-run, import, doctor</summary>

<br/>

All commands run via `npx tsx src/cli.ts <command>` in development, or `node dist/cli.js <command>` after `npm run build`.

### `serve` — start the web UI

```bash
npx tsx src/cli.ts serve
npx tsx src/cli.ts serve --port 9000
npx tsx src/cli.ts serve --collect   # also run the live WhatsApp collector
```

Opens the mobile-first web UI at `http://localhost:8787`. The `--collect` flag starts the live collector in the same process (links via QR on first run). The scheduler for twice-daily digests also starts here.

**Access from your phone (same Wi-Fi):**

```bash
ipconfig getifaddr en0   # macOS — find your machine's LAN IP
# Then open http://<ip>:8787 in your phone's browser
```

### `collect` — standalone live collector

```bash
npx tsx src/cli.ts collect
```

Links your WhatsApp account (QR on first run) and continuously stores incoming group messages. Usually you run `serve --collect` instead (both in one process). Run standalone only if you need the collector without the web UI.

### `summarize` — summarize a chat from the CLI

```bash
npx tsx src/cli.ts summarize "Family"                        # last 25 messages (default)
npx tsx src/cli.ts summarize "Family" --last 100             # last N messages
npx tsx src/cli.ts summarize "Family" --since 2026-05-30     # since a date (YYYY-MM-DD)
npx tsx src/cli.ts summarize "Family" --last 50 --out summary.txt  # write to a file
```

Generates a structured Hebrew markdown summary locally via Ollama. Voice-note transcripts are folded in automatically (run `transcribe` first if needed). An empty selection prints `Nothing to summarize for that selection.`

### `groups` — list stored chats

```bash
npx tsx src/cli.ts groups
```

Prints a numbered list of all stored groups and chats, e.g.:
```
1. Family (live, 12045 messages)
2. Work Chat (import, 5430 messages)
```

### `transcribe` — transcribe pending voice notes

```bash
npx tsx src/cli.ts transcribe
npx tsx src/cli.ts transcribe --group "Family"   # only this group
```

Runs `faster-whisper` locally on any voice notes that haven't been transcribed yet. The first run downloads the model (~1.5 GB). Safe to run multiple times (skips already-transcribed notes).

### `analyze-backlog` — enqueue vision analysis for existing media

```bash
npx tsx src/cli.ts analyze-backlog
npx tsx src/cli.ts analyze-backlog --limit 20
npx tsx src/cli.ts analyze-backlog --types analyze.image
```

Enqueues `analyze.image` and/or `analyze.video` jobs for media that has no completed analysis. Useful after enabling vision for the first time. Requires the worker to be running.

### `digest-run` — manually trigger a digest run

```bash
npx tsx src/cli.ts digest-run
npx tsx src/cli.ts digest-run --all   # enqueue all groups, not just those with new messages
```

Manually triggers the scheduled digest (enqueues `summarize.group` jobs for groups that have received new messages). Normally the digest runs automatically at `DIGEST_TIMES`.

### `import` — import a WhatsApp chat export

```bash
npx tsx src/cli.ts import ./chat.txt --name "Family"
npx tsx src/cli.ts import ./chat.zip --name "Family"        # includes media
npx tsx src/cli.ts import --folder ./exports                # bulk: enqueues all .txt/.zip files
```

Imports a WhatsApp export (`.txt` or `.zip`) into Postgres. Re-importing the same file is safe — messages are deduplicated by a stable key. Bulk mode enqueues background jobs; requires the worker to be running.

To export a chat from WhatsApp: open the chat → tap the group/contact name → scroll down to **Export Chat** → choose **Without Media** (`.txt`) or **Include Media** (`.zip`).

### `media-backfill` — download + analyze media stored without it

```bash
npx tsx src/cli.ts media-backfill
```

For messages saved with a media reference but no downloaded file (e.g. from onboarding), this scans a fresh linked session to download and analyze them. Note WhatsApp media URLs expire, so older media may be unrecoverable.

### `full-sync` — one-time full-history sync

```bash
npx tsx src/cli.ts full-sync --all                 # every chat
npx tsx src/cli.ts full-sync --group "Family"      # only whitelisted chats
```

Pulls deep history via a fresh linked device (scan the QR once) and persists it. Use `--all` for every chat or repeat `--group` to whitelist specific chats.

### `merge-duplicate-chats` — unify @lid / phone duplicate chats

```bash
npx tsx src/cli.ts merge-duplicate-chats           # dry-run (reports what it would merge)
npx tsx src/cli.ts merge-duplicate-chats --apply   # actually merge
```

WhatsApp can represent the same person as both an `@lid` and an `@s.whatsapp.net` chat, creating duplicates. This merges them. **Dry-run by default** — pass `--apply` to commit.

### `ops-sweep` — re-drive dead jobs once

```bash
npx tsx src/cli.ts ops-sweep
```

Manually triggers one operational sweep: re-drives dead/stuck jobs and records a status snapshot. Runs automatically on a schedule (`OPS_SWEEP_ENABLED`); this forces one now.

### `doctor` — verify prerequisites

```bash
npx tsx src/cli.ts doctor
```

See [Verify with `doctor`](#-verify-with-doctor) above.

</details>

---

## ⚙️ Configuration

<details>
<summary><strong>Expand the full <code>.env</code> reference</strong> — every key has a default</summary>

<br/>

Copy `.env.example` to `.env`. All keys have defaults; the table below lists every option.

| Key | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/whatsapp_sum` | Postgres connection string |
| `DATA_DIR` | `./data` | Directory for auth state, media downloads, and exports |
| `TRANSCRIPTION_PYTHON` | `python3` | Python interpreter with `faster-whisper` installed. `.env.example` sets this to `./.venv/bin/python` for the venv flow above. |
| `TRANSCRIPTION_MODEL` | `ivrit-ai/whisper-large-v3-turbo-ct2` | HuggingFace model for Hebrew speech-to-text (downloaded on first use) |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `OLLAMA_HOST` | `http://localhost:11434` | Local Ollama server base URL |
| `SUMMARY_MODEL` | `gemma4:26b` | Ollama model for generating summaries |
| `SUMMARY_NUM_CTX` | `32768` | Context window size (Ollama defaults to 2048 — this must be raised) |
| `SUMMARY_TOKEN_BUDGET` | `24000` | Max estimated input tokens before a selection is rejected as too large |
| `SUMMARY_TEMPERATURE` | `0.7` | Sampling temperature for the summary model |
| `SUMMARY_REPEAT_PENALTY` | `1.1` | Repeat penalty for the summary model |
| `SUMMARY_NUM_PREDICT` | `4096` | Max tokens the summary model may generate |
| `VISION_MODEL` | `gemma4:26b` | Ollama model for image captioning and OCR |
| `VISION_VIDEO_MODEL` | `gemma4:26b` | Ollama model for video analysis (defaults to `VISION_MODEL` if unset) |
| `VISION_VIDEO_FPS` | `1` | Frames per second sampled from videos |
| `VISION_VIDEO_MAX_FRAMES` | `8` | Maximum frames sent per video (caps memory usage) |
| `VISION_MAX_VIDEO_MB` | `25` | Maximum video file size (MB) accepted for analysis |
| `VISION_NUM_CTX` | `8192` | Context window for the vision model (kept small to control KV-cache memory) |
| `WEB_PORT` | `8787` | Port for the local web UI |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ AMQP connection URL |
| `LOG_LEVEL` | `info` | pino log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) |
| `WORKER_CONCURRENCY` | `1` | Concurrent jobs per worker process |
| `WHATSAPP_ALLOW_SEND` | `false` | Set `true` only to allow outbound WhatsApp messages. Leave `false` for passive collection. |
| `RETAIN_MEDIA` | `false` | Set `true` to keep media files on disk after analysis/transcription. By default files are pruned after captioning. |
| `DIGEST_ENABLED` | `true` | Enable scheduled twice-daily pre-summarization (so opening a group feels instant) |
| `DIGEST_TIMES` | `08:00,18:00` | Comma-separated HH:MM times (local timezone) for the digest runs |
| `OPS_SWEEP_ENABLED` | `true` | Enable the scheduled ops sweep (re-drive dead jobs + snapshot status). Set `false` to disable. |
| `OPS_SWEEP_TIMES` | `08:00,18:00` | Comma-separated HH:MM times for the ops sweep |
| `OPS_REDRIVE_CAP` | `2` | Max auto re-drives of a stuck work-item before it's flagged instead |
| `SUMBOX_DIAG_NAMES` | *(unset)* | Set to `1` to log extra name-resolution diagnostics from the collector. Diagnostic only. |

</details>

---

## 🏗️ Architecture

<details>
<summary><strong>Expand the architecture diagram and notes</strong></summary>

<br/>

```mermaid
flowchart TB
    imp["import / import --folder<br/>(.txt / .zip)"] --> norm["normalize + dedupe<br/>by stable key"]
    live["serve --collect / collect<br/>(Baileys QR, live)"] --> norm
    norm --> PG[("PostgreSQL<br/>source of truth")]

    PG --> voice["faster-whisper<br/>voice notes → transcripts"]
    PG --> media["Ollama vision<br/>images/video → captions"]
    voice --> llm["Ollama LLM<br/>structured summary"]
    media --> llm
    llm --> out["web UI · CLI · digest<br/>http://localhost:8787"]

    PG -. job refs only .-> mq{{"RabbitMQ work queue<br/>import · transcribe · analyze · summarize"}}
    mq -. competing consumers .-> worker["worker pool<br/>retries + dead-letter"]
    worker --> PG
```

- **Postgres** is the sole source of truth. The broker carries only job references (IDs), never message content.
- **Node.js** runs the CLI, web server, collector (Baileys), and worker.
- **Python + faster-whisper** runs as a subprocess for Hebrew voice-note transcription (local, nothing sent to any API).
- **Ollama** hosts the LLM and vision models locally.
- **Docker Compose** manages Postgres and RabbitMQ — the app itself runs on the host for GPU/CPU access.

</details>

---

## 🧯 Troubleshooting

<details>
<summary><strong>Expand common issues and fixes</strong></summary>

<br/>

**Out of memory / Ollama crashes**
The default `gemma4:26b` needs ~16 GB unified memory. Switch to a smaller model:
```bash
SUMMARY_MODEL=gemma4:12b
VISION_MODEL=gemma4:12b
```
See the [RAM table](#-ram--the-1-gotcha).

**QR code won't scan**
- Maximize your terminal — a small window breaks the QR rendering.
- The QR expires after ~20 seconds. Wait for the next one.
- Ensure your phone's WhatsApp is up to date.

**Session logged out**
WhatsApp may log out the linked device after inactivity. Delete the saved session and re-link:
```bash
rm -rf data/baileys-auth/
```
Then restart `make dev` or `serve --collect` and scan the new QR.

**Port conflicts**
If something already uses 5432 (Postgres) or 5672 (RabbitMQ), either stop the conflicting service or update `DATABASE_URL` / `RABBITMQ_URL` in `.env` to point at your existing instances.

**Docker not running**
`make dev` and `npm test` both require Docker. Start Docker Desktop (or the Docker daemon) and try again. Verify with `npx tsx src/cli.ts doctor`.

**Postgres migrations not applied**
If `doctor` reports `Postgres reachable + migrations applied ❌`, run:
```bash
npm run migrate
```

**`faster-whisper` not found** (e.g. `No module named 'faster_whisper'` in worker logs) — re-run setup:
```bash
make setup   # idempotent: builds/repairs .venv and sets TRANSCRIPTION_PYTHON in .env
```
This picks a Python ≥ 3.10 (the system `python3` is often 3.9, which is too old) and installs
`src/transcription/requirements.txt` into `.venv`. If you point `TRANSCRIPTION_PYTHON` at your own
interpreter, install faster-whisper there instead: `$TRANSCRIPTION_PYTHON -m pip install -r src/transcription/requirements.txt`.

</details>

---

## 💻 Development

<details>
<summary><strong>Expand build, test, and worker commands</strong></summary>

<br/>

```bash
npm run check         # Biome lint + format check (autofix: npm run check -- --write)
npm run typecheck     # TypeScript type-check (tsc --noEmit)
npm test              # Vitest test suite
npm run build         # Compile TypeScript to dist/
npm run migrate       # Apply database migrations
```

`npm run check → typecheck → build → test` is the full local CI gate — run `/preflight` to do all four and get the branch review-ready before a PR.

**Make targets** wrap the everyday flows:

```bash
make dev      # full local stack: infra + migrations + worker + web/collector (Ctrl-C stops all)
make up       # infra only — Postgres, RabbitMQ up + migrations applied
make down     # stop infra (make down ARGS=-v also wipes volumes)
make bench    # inference benchmark (see bench/README.md)
```

Tests use [Testcontainers](https://testcontainers.com/) for ephemeral Postgres and RabbitMQ — **Docker must be running** to run the full test suite.

The worker can be started independently for debugging:

```bash
npx tsx src/workers/worker.ts --types import.file,transcribe.voicenote,analyze.image,analyze.video,summarize.group,summarize.total
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

</details>

---

## License

**Apache 2.0 — © 2026 Eyal Delarea.** See [LICENSE](LICENSE).  
Bundled third-party dependencies keep their own licenses (see each package's
`package.json` / `LICENSE`).
