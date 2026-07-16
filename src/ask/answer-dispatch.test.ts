import { describe, expect, it, vi } from "vitest";
import { answerAida } from "./answer-dispatch.js";

const input = { groupId: 1, question: "q" };

describe("answerAida", () => {
  it("uses the agentic path when the flag is on", async () => {
    const runAgentic = vi.fn(async () => "agentic");
    const runSingleShot = vi.fn(async () => "single");
    expect(await answerAida({ agentic: true, runAgentic, runSingleShot }, input)).toBe("agentic");
    expect(runSingleShot).not.toHaveBeenCalled();
  });

  it("falls back to single-shot when the agentic path THROWS", async () => {
    const runAgentic = vi.fn(async () => {
      throw new Error("provider down");
    });
    const runSingleShot = vi.fn(async () => "single");
    const log = { warn: vi.fn() };
    expect(await answerAida({ agentic: true, runAgentic, runSingleShot, log }, input)).toBe(
      "single",
    );
    expect(log.warn).toHaveBeenCalled();
  });

  it("uses single-shot directly when the flag is off", async () => {
    const runAgentic = vi.fn(async () => "agentic");
    const runSingleShot = vi.fn(async () => "single");
    expect(await answerAida({ agentic: false, runAgentic, runSingleShot }, input)).toBe("single");
    expect(runAgentic).not.toHaveBeenCalled();
  });
});
