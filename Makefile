.PHONY: up down dev dev-worker dev-collect dev-ui setup bench bench-fixtures bench-all \
	langfuse-up langfuse-down langfuse-logs langfuse-verify

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

# --- Langfuse (opt-in, fully local — see ops/runbooks/langfuse-observability.md) -----------------------
# Self-hosted trace UI for the agentic @Aida loop. A SEPARATE compose project
# (`sumbox-langfuse`); `make up` never touches it. First boot pulls large images
# and runs migrations (~1-2 min). UI at http://localhost:3000. Wire the app with
# LANGFUSE_ENABLED=true (see .env.example).
langfuse-up:
	docker compose -f docker-compose.langfuse.yml up -d
	@echo "Langfuse starting → http://localhost:3000  (login admin@sumbox.local / sumbox-local)"

# Stop Langfuse (add ARGS=-v to also wipe its trace volumes).
langfuse-down:
	docker compose -f docker-compose.langfuse.yml down $(ARGS)

langfuse-logs:
	docker compose -f docker-compose.langfuse.yml logs -f $(ARGS)

# Static, config-level proof that the stack is local: telemetry off, no env value
# points off-machine, and the worker + datastores are on an internal (no-egress)
# network. This is hygiene, NOT a live-traffic capture — see ops/runbooks/langfuse-observability.md.
langfuse-verify:
	bash scripts/langfuse-verify.sh

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
