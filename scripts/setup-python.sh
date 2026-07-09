#!/usr/bin/env bash
#
# setup-python.sh — ensure the local faster-whisper environment is ready.
#
# Voice-note transcription runs in a Python subprocess (src/transcription/worker.py)
# that imports `faster_whisper`. If the interpreter the worker spawns lacks that module,
# EVERY transcribe.voicenote job fails instantly with "No module named 'faster_whisper'".
# That used to be a silent first-run footgun: `make dev` happily started the worker
# against the system python3 (often 3.9, no faster-whisper). This script makes the venv
# part of setup so it can't happen again.
#
# Idempotent: a fast `import faster_whisper` probe short-circuits when already set up, so
# it is safe to run on every `make dev`. It resolves the interpreter the SAME way the
# worker does (shell env > .env > project .venv) and only auto-provisions the project
# .venv — it never mutates a custom interpreter you pointed TRANSCRIPTION_PYTHON at.
#
set -euo pipefail
cd "$(dirname "$0")/.."

REQ="src/transcription/requirements.txt"
VENV_DIR=".venv"
VENV_PY="./$VENV_DIR/bin/python"

is_ready() { "$1" -c 'import faster_whisper' >/dev/null 2>&1; }

# ── Resolve the interpreter the worker will use ──────────────────────────────────────
# Mirror dotenv precedence: an exported shell var wins, else .env, else the project venv.
# (The bare code default is `python3` — the very trap we are closing — so when nothing is
# configured we standardize on ./.venv/bin/python and provision it below.)
PY="${TRANSCRIPTION_PYTHON:-}"
if [ -z "$PY" ] && [ -f .env ]; then
  PY="$(grep -E '^[[:space:]]*TRANSCRIPTION_PYTHON=' .env 2>/dev/null | tail -n1 \
        | cut -d= -f2- \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
              -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
fi
PY="${PY:-$VENV_PY}"

if is_ready "$PY"; then
  echo "✅ transcription: faster-whisper ready ($PY)"
  exit 0
fi

# ── Not ready — auto-provision ONLY when the target is the project venv ───────────────
case "$PY" in
  "$VENV_PY" | ".venv/bin/python" | */.venv/bin/python)
    echo "▶ transcription: setting up faster-whisper venv ($VENV_DIR)…"
    if [ ! -x "$VENV_PY" ]; then
      # faster-whisper needs Python >= 3.10; the system python3 is frequently 3.9.
      BASE=""
      for c in python3.12 python3.11 python3.13 python3.10 python3; do
        command -v "$c" >/dev/null 2>&1 || continue
        if "$c" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
          BASE="$c"
          break
        fi
      done
      if [ -z "$BASE" ]; then
        echo "⚠️  transcription: no Python >= 3.10 found — voice-note transcription will be OFF."
        echo "    Install one (e.g. 'brew install python@3.12'), then re-run 'make setup'."
        exit 1
      fi
      echo "  · creating $VENV_DIR with $("$BASE" --version 2>&1)"
      "$BASE" -m venv "$VENV_DIR"
    fi

    echo "  · installing $REQ (first run downloads a few wheels: ctranslate2, av, onnxruntime…)"
    "$VENV_PY" -m pip install --quiet --upgrade pip
    "$VENV_PY" -m pip install --quiet -r "$REQ"

    if ! is_ready "$VENV_PY"; then
      echo "⚠️  transcription: faster-whisper still not importable after install — see $REQ."
      exit 1
    fi
    echo "✅ transcription: faster-whisper installed ($VENV_PY)"

    # Persist the interpreter so EVERY entrypoint uses it (worker, `transcribe` CLI,
    # desktop) — not just `make dev`. Conservative: only add when absent, never overwrite
    # an existing value. .env is gitignored.
    if [ ! -f .env ]; then
      printf 'TRANSCRIPTION_PYTHON=%s\n' "$VENV_PY" >.env
      echo "  · wrote .env with TRANSCRIPTION_PYTHON=$VENV_PY"
    elif ! grep -qE '^[[:space:]]*TRANSCRIPTION_PYTHON=' .env; then
      printf 'TRANSCRIPTION_PYTHON=%s\n' "$VENV_PY" >>.env
      echo "  · added TRANSCRIPTION_PYTHON=$VENV_PY to .env"
    fi
    ;;
  *)
    # A custom interpreter that can't import the module — don't touch it, just tell them.
    echo "⚠️  transcription: TRANSCRIPTION_PYTHON=$PY cannot import faster_whisper."
    echo "    Install it there:  $PY -m pip install -r $REQ"
    echo "    (or unset TRANSCRIPTION_PYTHON to let setup build the project .venv)."
    exit 1
    ;;
esac
