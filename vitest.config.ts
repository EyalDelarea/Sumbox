import { defineConfig } from "vitest/config";

// Many tests use Testcontainers (Postgres, RabbitMQ). Container startup — especially
// on a cold image pull in CI — can exceed Vitest's default 5s hook timeout. Give
// setup/teardown and slow integration tests generous headroom.
//
// globalSetup boots ONE shared Postgres and migrates a template database once; each
// test file gets an isolated clone via `createTestDatabase()` (see src/test/db.ts),
// so files run safely in parallel without each booting their own container.
export default defineConfig({
  test: {
    globalSetup: ["./src/test/db.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Exclude heavy LLM evals (*.eval.test.ts) from the normal test run.
    // They call real Ollama and gracefully skip when it's absent, but running
    // them on every `npm test` would be unexpectedly slow locally.
    // Run them explicitly with `npm run eval:*`.
    // `.claude/**` keeps agent worktrees out of the run. `npm test` is
    // `vitest run src`, and that argument is a substring FILTER, not a
    // directory — so it also matches `.claude/worktrees/<branch>/src/**` and
    // runs every checked-out branch's tests alongside this one's. Measured on a
    // checkout with three worktrees: 7,368 tests and 27 failures, versus 1,624
    // and zero here. Those failures are stale code from other branches, they
    // are invisible to CI (which has no worktrees), and chasing them has burned
    // real time more than once.
    exclude: ["**/node_modules/**", "**/.git/**", "**/.claude/**", "**/*.eval.test.ts"],
  },
});
