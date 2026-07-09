#!/usr/bin/env bash
#
# dev-common.sh — shared helpers for the split dev processes (dev-worker / dev-collect /
# dev-ui). Sourced, not executed. Keeps each per-process script thin while reusing the
# same infra gate and pino pretty-printer as the all-in-one `make dev`.
#
# The split exists so you can restart ONE process — typically the web UI, after `git pull`
# — without bouncing the others. The worker churns on long Ollama jobs (media analysis,
# summaries) and the collector holds the live WhatsApp session; neither should restart
# just because the UI changed. Each process talks only to Postgres + RabbitMQ, so they
# are already decoupled — these scripts just let you run them independently.

# Resolve to the repo root regardless of where the sourcing script lives.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── Infra gate ───────────────────────────────────────────────────────────────────────
# Bring up Postgres + RabbitMQ (idempotent), wait until healthy, then apply migrations.
# Migrations are idempotent and near-instant when up to date, so every process runs this
# on start and on restart — a UI refresh after pulling a new migration stays correct.
ensure_stack() {
  echo "▶ Ensuring infra (postgres, rabbitmq)…"
  docker compose up -d postgres rabbitmq
  echo "▶ Waiting for Postgres + RabbitMQ to be healthy…"
  until docker compose ps postgres | grep -q "(healthy)"; do sleep 2; done
  until docker compose ps rabbitmq | grep -q "(healthy)"; do sleep 2; done
  echo "▶ Applying migrations…"
  npm run migrate
}

# ── Log prettifier ───────────────────────────────────────────────────────────────────
# Pretty-print pino JSON into readable, colored single lines. Non-JSON (plain console
# output, the QR) passes through unchanged. Falls back to cat if pino-pretty is missing.
# Mirrors `pretty` in dev.sh, minus the source prefix — each process now owns its terminal.
pretty() {
  if [ -x node_modules/.bin/pino-pretty ]; then
    node_modules/.bin/pino-pretty --translateTime SYS:HH:MM:ss --ignore pid,hostname,component \
      --colorize --singleLine --messageFormat '{if component}({component}) {end}{msg}'
  else
    cat
  fi
}
