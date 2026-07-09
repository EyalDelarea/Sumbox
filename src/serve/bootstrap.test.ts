import { describe, expect, it, vi } from "vitest";
import { startServe } from "./bootstrap.js";

/**
 * Smoke test for the extracted serve bootstrap. It exercises the early `--port`
 * validation, which runs before any pool/broker/collector is touched — so it needs no
 * infra. Its real value is guarding the (large) static import graph: a broken import
 * specifier in bootstrap.ts fails this test at module load.
 */
describe("startServe", () => {
  it("rejects an invalid --port before starting any infrastructure", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    try {
      await expect(startServe({ port: "-5" })).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
