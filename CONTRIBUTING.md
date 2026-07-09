# Contributing

Sumbox is a local-first project — all processing (collection, transcription, captioning, summarization) runs on your own machine. No cloud services are used, and no data should ever leave the device. Please keep that principle intact in any contribution.

Sumbox is licensed under **Apache 2.0**. By contributing, you agree that your
contributions will be licensed under the same license.

## Getting started

1. Create a feature branch off `main` (`feat/…` · `fix/…` · `docs/…` · `chore/…`).
2. Follow the [Quick Start](README.md#quick-start) to get the stack running locally.
3. Make your changes.

## Before opening a PR

Run the full local CI gate (the same one CI enforces as `ci-ok`) — or just run `/preflight`:

```bash
npm run check         # biome lint/format — autofix with `npm run check -- --write`
npm run typecheck     # must pass — zero TypeScript errors
npm run build         # must compile + copy web assets
npm test              # must pass — Docker must be running (Testcontainers)
```

All four are required. Docker must be running for the test suite because tests spin up ephemeral Postgres and RabbitMQ containers via Testcontainers. CI runs the same gate on GitHub-hosted `ubuntu-latest` runners.

## Pull request guidelines

- Keep PRs focused on a single concern.
- Add or update tests for any changed behavior.
- Do not introduce dependencies on external APIs, cloud services, or any network calls from production code paths. Everything must work fully offline.
- Update the relevant section of `README.md` if you add or change CLI commands, configuration keys, or ports.

## Database migrations

Migrations live in `src/db/migrations/`, named `<number>_<description>.ts`, and run
in ascending numeric order by `node-pg-migrate`. Their numbers must be **unique** —
two files with the same number break deploys (the later one sorts before an applied
migration and `checkOrder` aborts).

**Always create migrations with `npm run migrate:create -- <name>`.** It prefixes the
filename with a millisecond timestamp, so parallel branches/agents can't pick the same
number — collisions are prevented by construction. Never hand-number a file.

As a backstop, `src/db/migrations.test.ts` fails CI on any duplicate number, on the
PR's merged state — so even a hand-numbered collision is caught before it reaches
`main` (renumber and push if it goes red).

## Local-first principle

Sumbox is designed so a user with no cloud account and no internet connection (beyond the initial `npm install` and model pull) can run the full pipeline. Contributions that require external services will not be merged.
