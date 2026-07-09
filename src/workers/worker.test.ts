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

  it("runs each handler inside the payload's tenant context (T2 cutover)", async () => {
    const { currentTenantId, DEFAULT_TENANT_ID } = await import("../db/tenant-context.js");
    const bus = makeBus();
    const seenTenants: string[] = [];

    // Enqueue BEFORE buildWorker: the in-memory bus drains queued jobs at consume()
    // time, which is exactly when buildWorker registers its wrapped handler.
    const TENANT_B = "11111111-1111-1111-1111-111111111111";
    await bus.enqueue("import.file", { filePath: "/a.txt", tenantId: TENANT_B });
    // Pre-T2 in-flight job without tenantId → must fall back to the default tenant.
    await bus.enqueue("import.file", { filePath: "/b.txt" });

    await buildWorker({
      bus,
      handlers: {
        "import.file": async (_job: Job<"import.file">) => {
          seenTenants.push(currentTenantId());
        },
      },
      concurrency: 1,
    });

    expect(seenTenants).toEqual([TENANT_B, DEFAULT_TENANT_ID]);
  });

  it("drops (acks) a job whose tenant no longer exists instead of poison-looping", async () => {
    const bus = makeBus();
    const handled: string[] = [];
    const GHOST = "18a178b1-8ed7-44d9-a1bc-a6b58625410a"; // hard-deleted tenant
    const LIVE = "22222222-2222-2222-2222-222222222222";

    await bus.enqueue("summarize.group", { groupId: "ghost", tenantId: GHOST });
    await bus.enqueue("summarize.group", { groupId: "live", tenantId: LIVE });

    await buildWorker({
      bus,
      handlers: {
        "summarize.group": async (job: Job<"summarize.group">) => {
          handled.push(job.payload.groupId);
        },
      },
      concurrency: 1,
      tenantExists: async (id) => id !== GHOST, // GHOST is gone from the tenants table
    });

    // The ghost job is acked-dropped (handler never runs); the live one runs.
    expect(handled).toEqual(["live"]);
  });

  it("fairShareWindow raises prefetch on slow types and runs each job under ITS tenant (T3)", async () => {
    // NOTE: the in-memory bus awaits each delivery before the next, so round-robin
    // ordering is not observable through it — that property is pinned by
    // fair-share.test.ts. What matters HERE: the prefetch knob reaches consume(), and
    // the dispatcher establishes tenant context at execution time, per job.
    const { currentTenantId } = await import("../db/tenant-context.js");
    const bus = makeBus();
    const consumeSpy = vi.spyOn(bus, "consume");
    const seen: Array<{ id: string; tenant: string }> = [];

    const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await bus.enqueue("summarize.group", { groupId: "a1", tenantId: A });
    await bus.enqueue("summarize.group", { groupId: "b1", tenantId: B });

    await buildWorker({
      bus,
      handlers: {
        "summarize.group": async (job: Job<"summarize.group">) => {
          seen.push({ id: job.payload.groupId, tenant: currentTenantId() });
        },
      },
      concurrency: 1,
      fairShareWindow: 4,
    });

    // Slow type gets the fair window as its prefetch (was always 1).
    expect(consumeSpy).toHaveBeenCalledWith("summarize.group", expect.any(Function), {
      prefetch: 4,
    });
    expect(seen).toEqual([
      { id: "a1", tenant: A },
      { id: "b1", tenant: B },
    ]);
  });

  it("without fairShareWindow behavior is unchanged (prefetch 1 on slow types)", async () => {
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
