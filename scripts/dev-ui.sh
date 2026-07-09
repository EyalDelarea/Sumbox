#!/usr/bin/env bash
#
# dev-ui.sh — run ONLY the web UI (serve WITHOUT the collector). This is the process you
# refresh after `git pull`: Ctrl-C here, pull, re-run — the worker and collector keep
# running untouched. No WhatsApp session is held here, so restarts are instant and safe.
#
set -euo pipefail
source "$(dirname "$0")/dev-common.sh"

ensure_stack

echo "▶ Starting web UI → http://localhost:8787  (no collector; run 'make dev-collect' for WhatsApp)…"
npx tsx src/cli.ts serve 2>&1 | pretty
