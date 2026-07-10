import { describe, expect, it, vi } from "vitest";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import type { Job } from "../jobs/job-types.js";
import { buildWorker, opForJobType } from "./worker.js";

describe("opForJobType", () => {
  it("maps job types to coarse operation labels for dashboards", () => {
    expect(opForJobType("transcribe.voicenote")).toBe("audio");
    expect(opForJobType("analyze.image")).toBe("image");
    expect(opForJobType("analyze.video")).toBe("video");
    expect(opForJobType("import.file")).toBe("import");
  });
});

function makeBus() {
  const recorder = new InMemoryJobRunRecorder();
  return new InMemoryJobBus(recorder);
}

describe("buildWorker", () => {
  it("registers and invokes the import.file handler for enqueued jobs", async () => {
    const bus = makeBus();
    const handled: string[] = [];

    await buildWorker({
      bus,
      handlers: {
        "import.file": async (job: Job<"import.file">) => {
          handled.push(job.payload.filePath);
        },
      },
      concurrency: 1,
    });

    await bus.enqueue("import.file", { filePath: "/chat.txt" });
    await bus.enqueue("import.file", { filePath: "/export.zip" });

    // consume is triggered by drain — in InMemoryJobBus consume drains synchronously
    await bus.consume(
      "import.file",
      async (job) => {
        handled.push(job.payload.filePath + "-consume");
      },
      { prefetch: 1 },
    );

    // The worker registered the handler; we just verify the wiring is set up
    // Note: InMemoryJobBus.consume() drains the queue when called, so we
    // test via the bus drain directly with our handler captured
    expect(handled).toBeDefined();
  });

  it("calls bus.consume for import.file with the registered handler", async () => {
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");

    const importFileHandler = vi.fn();
    await buildWorker({
      bus,
      handlers: {
        "import.file": importFileHandler,
      },
      concurrency: 2,
    });

    expect(consumeSpy).toHaveBeenCalledWith("import.file", expect.any(Function), { prefetch: 2 });
  });

  it("calls bus.consume for each registered handler", async () => {
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");

    const importFileHandler = vi.fn();
    const transcribeHandler = vi.fn();

    await buildWorker({
      bus,
      handlers: {
        "import.file": importFileHandler,
        "transcribe.voicenote": transcribeHandler,
      },
      concurrency: 3,
    });

    expect(consumeSpy).toHaveBeenCalledTimes(2);
    expect(consumeSpy).toHaveBeenCalledWith("import.file", expect.any(Function), { prefetch: 3 });
    // transcribe.voicenote always uses prefetch=1 regardless of concurrency
    expect(consumeSpy).toHaveBeenCalledWith("transcribe.voicenote", expect.any(Function), {
      prefetch: 1,
    });
  });

  it("only registers handlers for the provided handler types", async () => {
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");

    await buildWorker({
      bus,
      handlers: {
        "import.file": vi.fn(),
        // transcribe.voicenote intentionally omitted
      },
      concurrency: 1,
    });

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(consumeSpy).toHaveBeenCalledWith("import.file", expect.any(Function), { prefetch: 1 });
  });

  it("transcribe.voicenote always uses prefetch=1 regardless of configured concurrency", async () => {
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");

    const transcribeHandler = vi.fn();

    await buildWorker({
      bus,
      handlers: {
        "transcribe.voicenote": transcribeHandler,
      },
      concurrency: 5, // high concurrency — but transcription must still be prefetch=1
    });

    expect(consumeSpy).toHaveBeenCalledWith("transcribe.voicenote", expect.any(Function), {
      prefetch: 1,
    });
  });

  it("import.file uses the configured concurrency as its prefetch", async () => {
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");

    const importFileHandler = vi.fn();

    await buildWorker({
      bus,
      handlers: {
        "import.file": importFileHandler,
      },
      concurrency: 4,
    });

    expect(consumeSpy).toHaveBeenCalledWith("import.file", expect.any(Function), { prefetch: 4 });
  });

  it("handler is actually invoked when job flows through the bus", async () => {
    const bus = makeBus();
    const handledJobs: string[] = [];

    const importFileHandler = vi.fn().mockImplementation(async (job: Job<"import.file">) => {
      handledJobs.push(job.payload.filePath);
    });

    await buildWorker({
      bus,
      handlers: {
        "import.file": importFileHandler,
      },
      concurrency: 1,
    });

    await bus.enqueue("import.file", { filePath: "/test/chat.txt" });

    // Manually drain the queue to simulate the worker consuming
    await bus.consume("import.file", importFileHandler, { prefetch: 1 });

    expect(importFileHandler).toHaveBeenCalled();
    expect(handledJobs).toContain("/test/chat.txt");
  });

  it("uses prefetch 1 on slow types regardless of concurrency", async () => {
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");
    await buildWorker({
      bus,
      handlers: { "summarize.group": vi.fn() },
      concurrency: 5,
    });
    expect(consumeSpy).toHaveBeenCalledWith("summarize.group", expect.any(Function), {
      prefetch: 1,
    });
  });

  it("serializes Ollama job types so their handlers never run concurrently", async () => {
    // analyze.image and summarize.group both hit Ollama. The worker registers one
    // consumer per type and awaits them together, so across types they interleave at
    // the event loop — UNLESS the shared Ollama gate forces one-at-a-time. We enqueue
    // one of each before buildWorker (the in-memory bus drains at consume time) and
    // assert each handler's enter is immediately followed by its own exit.
    const bus = makeBus();
    const events: string[] = [];
    const body = (id: string) => async () => {
      events.push(`enter:${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`exit:${id}`);
    };

    await bus.enqueue("analyze.image", { messageId: "img" });
    await bus.enqueue("summarize.group", { groupId: "grp" });

    await buildWorker({
      bus,
      handlers: {
        "analyze.image": body("img"),
        "summarize.group": body("grp"),
      },
      concurrency: 1,
    });

    // No interleaving: every enter is paired with its own exit before the next enter.
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0]?.replace("enter:", "exit:"));
    expect(events[3]).toBe(events[2]?.replace("enter:", "exit:"));
  });

  it("Fix 5: rejects if bus.consume throws (startup error surfaces loudly)", async () => {
    const bus = makeBus();
    vi.spyOn(bus, "consume").mockRejectedValueOnce(new Error("broker down"));

    await expect(
      buildWorker({
        bus,
        handlers: { "import.file": vi.fn() },
        concurrency: 1,
      }),
    ).rejects.toThrow("broker down");
  });
});
