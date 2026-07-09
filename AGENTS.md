# AGENTS.md

Grounding for agent sessions on **Sumbox** — a local, single-user WhatsApp
summarizer built for fun. Privacy is a hard constraint: all inference (LLM,
speech-to-text, vision) runs locally via Ollama + faster-whisper; message
content never leaves the device. Hebrew is first-class (RTL UI, Hebrew
models). See `PROJECT_OVERVIEW.md` and `README.md` for the full picture.

> **Agent behavior contract:** @GOVERNANCE.md — the three immutable layers
> (Spec · Verifier · Environment) that govern how agents work here. Read it.

**Single-user, zero-config.** There is no login and no server-side accounts —
everything runs against one Postgres database as a single fixed tenant. The
`tenant_id` columns and Postgres RLS policies on those tables are dormant
plumbing left in place from an earlier design; the app connects as the DB
owner and never exercises them at runtime. Don't build new user-facing
features on top of them — treat them as inert history, not an available
capability.

## Stack

- **Node ≥22**, TypeScript (ESM, `"type": "module"` — use `.js` import specifiers).
- **PostgreSQL** (source of truth) via `pg`; migrations via `node-pg-migrate`.
- **RabbitMQ** job bus (`amqplib`); workers under `src/workers/handlers`.
- **Biome** for lint/format. **Vitest** + **Testcontainers** for tests.
- WhatsApp link via Baileys; CLI via `commander`; web is a small RTL mobile app.

## The ship lifecycle (recurring flow — follow it every time)

```
1. branch off main      feat/… · fix/… · docs/… · chore/…  (or Codex/… for agent work)
2. build bottom-up      atomic, scoped conventional commits (see below)
3. sync main in         git merge origin/main   (resolve, re-number migrations if needed)
4. PREFLIGHT            biome check → typecheck → build → test   (the local CI gate)
5. open PR              CI runs the same gate; the `ci-ok` check must go green
6. HUMAN VERIFY         Eyal runs the code and confirms behavior — this gate is his, not the agent's
7. merge PR
```

Steps 1–5 are the agent's job: **prepare everything and get to a green, review-ready
PR.** Step 6 is the human gate — do not assume it; hand off a PR that's easy to run
and verify. Run `/preflight` before opening or updating a PR.

## Commits — atomic, scoped, conventional

Never squash a feature into one commit. Build it as a **stack of small commits**,
bottom-up: data structures / interfaces first, then implementations, then
orchestration, then surfaces (CLI / HTTP), then `refactor`/`style`/`fix` cleanups.

Format: `type(scope): summary`

- **types:** `feat` `fix` `refactor` `docs` `chore` `build` `test` `style` `perf` `ci`
- **scopes (established vocabulary — reuse, don't invent):**
  `collector` `db` `logging` `ui` `media` `web` `cli` `summary` `serve` `bench`
  `deps` `deps-dev` `full-sync` `backfill`

## The CI gate (must pass before PR — `/preflight` runs it)

```
npm run check      # biome check src   (CI runs `biome ci src`; use `--write` / `npm run format` to autofix)
npm run typecheck  # tsc --noEmit
npm run build      # tsc + copy web assets
npm test           # vitest — needs Docker (Testcontainers spin up Postgres + RabbitMQ)
```

CI collapses lint + typecheck + build + test into a single required `ci-ok` check.
Common avoidable round-trips seen in history: **unused imports** and **unformatted
code** — run `npm run check --write` before committing. CI runs on GitHub-hosted
`ubuntu-latest` runners.

## Tests

- Colocate `*.test.ts` next to the source it covers.
- Inject probes rather than mocking globals (`const ok = () => Promise.resolve(true)`,
  `fail`, `throws`). Prefer dependency injection for time, pools, and IO.
- A shared Postgres boots once in `globalSetup` (`src/test/db.ts`); each file gets an
  isolated DB clone so files run in parallel. Tests need Docker available.

## Migrations

- `node-pg-migrate`, files in `src/db/migrations/`, **one concern each**, with both
  `up` and `down`. Create with `npm run migrate:create -- <name>` — it timestamp-prefixes
  the filename so parallel branches can't collide; never hand-number. (`migrations.test.ts`
  fails CI on any duplicate number as a backstop.)
- Migrations are never rewritten or squashed after merge — dead columns/tables from
  removed features stay as inert history rather than being retrofitted.

## Code style

- ESM with explicit `.js` specifiers on relative imports.
- Section dividers in non-trivial files: `// ── Helpers ─────────────────────────`.
- Repository pattern for DB access (`src/db/repositories`); worker logic in
  `src/workers/handlers`; operational tooling under `src/ops` and `src/doctor`.

## Local dev

- `make up` — infra (Postgres/RabbitMQ) up + migrate. `make dev` — full local stack.
- `npm run dev` — run the CLI via tsx. `npm run worker` — run a worker.
- **Split dev** (restart one process without bouncing the others): `make dev-worker`
  (jobs), `make dev-collect` (WhatsApp session), `make dev-ui` (web UI only — `serve`
  without the collector). Each in its own terminal. After `git pull`, Ctrl-C `dev-ui` and
  re-run it to refresh the UI while the worker keeps its jobs and the collector keeps its
  session. The processes share only Postgres + RabbitMQ, so they're already decoupled.
