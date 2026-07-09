#!/usr/bin/env bash
# Full four-config sweep across two Ollama SERVER states.
#
# Flash Attention and KV-cache quantization are server-process env vars, not per-request
# options — so they require (re)starting Ollama. This script:
#   Pass 1 (default flags):        baseline + vision-7b
#   Pass 2 (flash-attn + kv q8_0): tuned + combined
#
# It momentarily STOPS the Ollama desktop app's server and runs its own `ollama serve`,
# then stops it on exit. Relaunch Ollama.app afterwards if you normally use it.
#
# Extra args are forwarded to bench/run.ts (e.g. `bash bench/run-all.sh --runs 3`).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${OLLAMA_HOST:-http://localhost:11434}"
PIDFILE="$(mktemp -t bench-ollama-pid.XXXX)"

ready()    { curl -s -m 2 "$HOST/api/version" >/dev/null 2>&1; }
wait_up()  { for _ in $(seq 1 90); do ready && return 0; sleep 1; done; echo "Ollama never became ready" >&2; return 1; }
wait_down(){ for _ in $(seq 1 30); do ready || return 0; sleep 1; done; return 0; }

stop_ollama() {
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" >/dev/null 2>&1 || true
  osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
  pkill -f "ollama serve" >/dev/null 2>&1 || true
  wait_down
}

start_ollama() { # args: KEY=VAL ...
  echo "    starting: ollama serve ($*)"
  env "$@" ollama serve >/tmp/bench-ollama.log 2>&1 &
  echo $! > "$PIDFILE"
  wait_up
}

cleanup() { stop_ollama; rm -f "$PIDFILE"; }
trap cleanup EXIT

echo "==> Stopping any running Ollama (desktop app or serve)..."
stop_ollama

echo "==> Pass 1/2: DEFAULT server flags  (baseline, vision-7b)"
start_ollama
npx tsx bench/run.ts --configs baseline,vision-7b --server-config default --tag default "$@"
stop_ollama

echo "==> Pass 2/2: FLASH ATTENTION + KV CACHE q8_0  (tuned, combined)"
start_ollama OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0
npx tsx bench/run.ts --configs tuned,combined --server-config flash+kv-q8_0 --tag flashkv "$@"

echo
echo "Done. Two result files written under bench/results/ (tags: -default, -flashkv)."
echo "Relaunch Ollama.app if you normally use the desktop app."
