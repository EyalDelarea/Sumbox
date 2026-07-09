#!/usr/bin/env bash
#
# dev.sh — one-command local stack for Sumbox.
#
# Brings up infra (Postgres + RabbitMQ), applies migrations, then runs the
# worker AND the web+collector together with combined, labeled logs. Ctrl-C stops
# everything. Refuses to start if a collector is already running (two WhatsApp
# sessions on one linked device conflict and flap).
#
set -euo pipefail
cd "$(dirname "$0")/.."

# --- Guard: never run a second collector FROM THIS REPO (the double-session
# WhatsApp conflict). Scoped to this repo's working directory (set by the cd
# above) so a DIFFERENT app on the same machine — running its own
# `src/cli.ts serve` on a separate DB/number — does not false-block us. Only
# same-repo serve/collect processes count as a conflict. ---
SELF_DIR="$PWD"
conflict_pids=""
for pid in $(pgrep -f "src/cli.ts (serve|collect)" 2>/dev/null || true); do
  # macOS/lsof: the `n` line of the cwd fd is the process's working directory.
  cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$cwd" in
    "$SELF_DIR" | "$SELF_DIR"/*) conflict_pids="$conflict_pids $pid" ;;
  esac
done
if [ -n "$conflict_pids" ]; then
  echo "✋ A collector/serve process from THIS repo is already running — refusing to start a second one"
  echo "   (two WhatsApp sessions on one device conflict). Stop it first:"
  for pid in $conflict_pids; do ps -p "$pid" -o pid=,command= 2>/dev/null || true; done
  exit 1
fi

# --- First-run setup: ensure the faster-whisper venv exists --------------------------
# The worker transcribes voice notes in a Python subprocess that imports faster_whisper.
# Without the venv it silently falls back to system python3 and every transcribe job
# fails. Provision it here so `make dev` is self-sufficient. Non-fatal: the rest of the
# stack (collector, summaries, vision) still runs if transcription can't be set up.
if ! bash scripts/setup-python.sh; then
  echo "⚠️  Continuing without voice-note transcription (see the message above)."
fi

echo "▶ Bringing up infra (postgres, rabbitmq)…"
docker compose up -d postgres rabbitmq

echo "▶ Waiting for Postgres + RabbitMQ to be healthy…"
until docker compose ps postgres | grep -q "(healthy)"; do sleep 2; done
until docker compose ps rabbitmq | grep -q "(healthy)"; do sleep 2; done

echo "▶ Applying migrations…"
npm run migrate

# We track the PID of each pipeline we spawn (set below) and, on exit, kill its
# whole process group — so the pipeline's children (tsx/node, pino-pretty, the
# prefix loop) go down with it. Initialized empty so the trap is safe under
# `set -u` if a signal lands before the jobs start.
#
# Deliberately NOT `pkill -f`: that matches on the FULL command line of every
# process on the machine, so it can take out unrelated processes — an editor with
# this file open, another `tsx` invocation, a second dev stack. Targeting the
# exact PIDs we started keeps the blast radius to our own jobs.
WORKER_PID=""
SERVE_PID=""
cleanup() {
  echo
  echo "▶ Shutting down worker + serve…"
  for pid in "$SERVE_PID" "$WORKER_PID"; do
    [ -n "$pid" ] || continue
    # `-$pid` targets the process group led by the subshell (made a group leader
    # by `set -m` at launch); fall back to the bare PID if no such group exists.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  exit 0
}
trap cleanup INT TERM

echo "▶ Starting worker + serve --collect…"

# Colored source prefixes (only when stdout is a real terminal — keep pipes/files clean).
if [ -t 1 ]; then
  C_WORKER=$'\033[1;35m'   # bold magenta
  C_SERVE=$'\033[1;36m'    # bold cyan
  C_RESET=$'\033[0m'
else
  C_WORKER='' ; C_SERVE='' ; C_RESET=''
fi
WORKER_PREFIX="${C_WORKER}[worker]${C_RESET}"
SERVE_PREFIX="${C_SERVE}[serve] ${C_RESET}"

# Pretty-print pino JSON logs into readable, colored lines. Non-JSON lines pass
# through unchanged, so plain console.log output and the QR survive. Falls back
# to a passthrough (cat) if pino-pretty is somehow unavailable.
# A function (not a var) so the multi-word --messageFormat survives unquoted
# pipe expansion. Renders the source inline: "[12:20:24] INFO (collector): connected".
pretty() {
  if [ -x node_modules/.bin/pino-pretty ]; then
    # --singleLine keeps each log on ONE line (extra fields as a compact trailing
    # object instead of an indented block). `component` is ignored from that
    # object since it's already shown inline as "(component)" via messageFormat.
    node_modules/.bin/pino-pretty --translateTime SYS:HH:MM:ss --ignore pid,hostname,component \
      --colorize --singleLine --messageFormat '{if component}({component}) {end}{msg}'
  else
    cat
  fi
}

# Media analysis (analyze.image/.video) re-enabled so NEW media gets captioned
# going forward (gemma4:26b + think:false, multi-frame video). It shares the model
# with summaries (serial worker), so to catch up history use a bounded enqueue, e.g.
# `npx tsx src/cli.ts analyze-backlog --limit 20`, rather than draining everything.
# summarize.group runs the scheduled per-chat digest (feature 011);
# summarize.total runs the scheduled cross-chat total summary.
# `set -m` (job control) puts each backgrounded pipeline in its own process group
# so cleanup() can take the whole group down by PID; we capture each subshell's
# PID via `$!` right after launch. Restored to the default afterwards.
set -m
( npx tsx src/workers/worker.ts --types import.file,transcribe.voicenote,analyze.image,analyze.video,summarize.group,summarize.total,suggest.generate 2>&1 \
    | pretty \
    | while IFS= read -r l; do printf '%s %s\n' "$WORKER_PREFIX" "$l"; done ) &
WORKER_PID=$!
( npx tsx src/cli.ts serve --collect 2>&1 \
    | pretty \
    | while IFS= read -r l; do printf '%s %s\n' "$SERVE_PREFIX" "$l"; done ) &
SERVE_PID=$!
set +m

cat <<'EOF'

  ✅ Stack up:
     Web UI    → http://localhost:8787   (summarize + status panel)
     RabbitMQ  → http://localhost:15672  (guest/guest)

  Scan the QR once if prompted (read-only collector). Ctrl-C stops everything.

EOF

wait
