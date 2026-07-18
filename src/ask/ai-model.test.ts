import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { makeAgenticModel } from "./ai-model.js";

describe("makeAgenticModel", () => {
  it("builds a model bound to the given ollama host + model tag", () => {
    const model = makeAgenticModel({ host: "http://localhost:11434", model: "gemma4:26b" });
    expect(model).toBeTruthy();
    expect(model.modelId).toBe("gemma4:26b");
  });

  it("sends keep_alive on every chat request so gemma stays resident", async () => {
    // Ollama's 5m default meant a question after a quiet spell paid a cold load
    // (measured 3.4s vs 0.4s warm). The provider's chat path has no keepAlive
    // setting, so it is injected at the fetch layer — this asserts it actually
    // reaches the request body, where a provider upgrade would silently drop it.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "gemma4:26b",
            created_at: new Date().toISOString(),
            message: { role: "assistant", content: "ok" },
            done: true,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const model = makeAgenticModel({
      host: "http://localhost:11434",
      model: "gemma4:26b",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await generateText({ model, prompt: "hi" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.keep_alive).toBe("60m");
  });
});
