#!/usr/bin/env bash
#
# dev-collect.sh — run ONLY the live WhatsApp collector. Holds the linked-device session,
# so restart it rarely (a fresh session re-link briefly flaps). Ctrl-C stops just this
# process. One collector at a time — two WhatsApp sessions on one device conflict.
#
set -euo pipefail
source "$(dirname "$0")/dev-common.sh"

# Guard: never run a second collector. The all-in-one `make dev` runs `serve --collect`,
# which also counts — match it and a standalone collect, but NOT plain `serve` (dev-ui).
if pgrep -f "src/cli.ts (serve --collect|collect)" >/dev/null 2>&1; then
  echo "✋ A collector is already running — refusing to start a second one"
  echo "   (two WhatsApp sessions on one device conflict). Stop it first:"
  pgrep -fl "src/cli.ts (serve --collect|collect)" || true
  exit 1
fi

ensure_stack

echo "▶ Starting collector (link via QR on first run)…"
npx tsx src/cli.ts collect 2>&1 | pretty
