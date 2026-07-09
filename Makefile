.PHONY: up down dev dev-worker dev-collect dev-ui setup bench bench-fixtures bench-all

# One command for local dev: infra (postgres/rabbitmq) + migrations + worker +
# web/collector together with combined logs. Refuses to start a second collector.
# (dev.sh provisions the faster-whisper venv on first run — see `setup`.)
dev:
	bash scripts/dev.sh

# Split dev: run each process in its own terminal so you can restart ONE without bouncing
# the others. Refresh the UI after `git pull` (Ctrl-C dev-ui, pull, re-run) while the
# worker keeps churning jobs and the collector keeps its WhatsApp session. Each target
# ensures infra + migrations itself; the processes talk only via Postgres + RabbitMQ.
dev-worker:
	bash scripts/dev-worker.sh

dev-collect:
	bash scripts/dev-collect.sh

dev-ui:
	bash scripts/dev-ui.sh

# First-time (or repair) setup of the local faster-whisper venv used for Hebrew
# voice-note transcription. Idempotent; `make dev` runs this automatically.
setup:
	bash scripts/setup-python.sh

# Bring up all infra, wait for postgres + rabbitmq to be healthy, then run migrations.
up:
	docker compose up -d
	@echo "Waiting for postgres to be healthy..."
	@until docker compose ps postgres | grep -q "(healthy)"; do \
		sleep 2; \
	done
	@echo "Postgres is healthy."
	@echo "Waiting for rabbitmq to be healthy..."
	@until docker compose ps rabbitmq | grep -q "(healthy)"; do \
		sleep 2; \
	done
	@echo "RabbitMQ is healthy."
	npm run migrate

# Stop and remove all infra containers (add make down ARGS=-v to wipe volumes).
down:
	docker compose down $(ARGS)

# --- Inference benchmark (see bench/README.md) -----------------------------------
# Generate neutral, license-free fixtures (idempotent; needs ffmpeg).
bench-fixtures:
	bash bench/fixtures/generate.sh

# Run the headline comparison against the CURRENTLY running Ollama (no daemon restart):
# baseline (gemma4:26b) vs vision-7b (qwen2.5vl). Override configs/runs via ARGS, e.g.
#   make bench ARGS="--configs baseline --runs 3"
bench: bench-fixtures
	npx tsx bench/run.ts --configs baseline,vision-7b $(ARGS)

# Full four-config sweep INCLUDING the Flash-Attention + KV-q8_0 server states.
# This restarts the Ollama server twice (see bench/run-all.sh) — it will momentarily
# stop the desktop app's server; relaunch Ollama.app afterwards if you use it.
bench-all: bench-fixtures
	bash bench/run-all.sh $(ARGS)
