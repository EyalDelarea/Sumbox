import { describe, expect, it } from "vitest";
import { makeAgenticModel } from "./ai-model.js";

describe("makeAgenticModel", () => {
  it("builds a model bound to the given ollama host + model tag", () => {
    const model = makeAgenticModel({ host: "http://localhost:11434", model: "gemma4:26b" });
    expect(model).toBeTruthy();
    expect(model.modelId).toBe("gemma4:26b");
  });
});
