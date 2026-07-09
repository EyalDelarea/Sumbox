import { defineConfig } from "vitest/config";

// Separate config for LLM evals — used only by `npm run eval:*`.
// Explicitly includes *.eval.test.ts (excluded from main vitest.config.ts).
// No globalSetup: evals call Ollama only, not Postgres.
export default defineConfig({
  test: {
    include: ["src/**/*.eval.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
