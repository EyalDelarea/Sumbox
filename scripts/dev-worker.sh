#!/usr/bin/env bash
#
# dev-worker.sh — run ONLY the job worker (transcribe, media analysis, summaries,
# suggestions). Long-lived: leave it running across UI refreshes. Restart it yourself
# only when worker code changes and you want the new behavior. Ctrl-C stops just this
# process — the UI and collector keep running.
#
set -euo pipefail
source "$(dirname "$0")/dev-common.sh"

# The worker transcribes voice notes in a Python subprocess; ensure the faster-whisper
# venv exists (fast no-op once provisioned). Non-fatal — the rest of the worker runs.
if ! bash scripts/setup-python.sh; then
  echo "⚠️  Continuing without voice-note transcription (see the message above)."
fi

ensure_stack

echo "▶ Starting worker…"
npx tsx src/workers/worker.ts \
  --types import.file,transcribe.voicenote,analyze.image,analyze.video,summarize.group,summarize.total \
  2>&1 | pretty
