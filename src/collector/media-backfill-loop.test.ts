import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TENANT_ID } from "../db/tenant-context.js";
import { runBackfillBatch, startBackfillLoop } from "./media-backfill-loop.js";

const baseDeps = (over: Partial<any> = {}) => ({
  selectPending: vi
    .fn()
    .mockResolvedValue([
      { messageId: 1, groupId: 9, mediaKind: "image", waMessage: Buffer.from([0xaa]) },
    ]),
  decodeWaMessage: vi.fn().mockReturnValue({ key: { id: "X" } }),
  download: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue("/data/media/backfill/1.jpg"),
  markPresentMessage: vi.fn().mockResolvedValue(undefined),
  markPresentMedia: vi.fn().mockResolvedValue(undefined),
  markUnrecoverable: vi.fn().mockResolvedValue(undefined),
  recordAttempt: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn().mockResolvedValue(undefined),
  ...over,
});

const logSpy = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });

describe("runBackfillBatch", () => {
  it("downloads, marks present, and enqueues analyze.image", async () => {
    const deps = baseDeps();
    const n = await runBackfillBatch(deps as any, 10);
    expect(n).toBe(1);
    expect(deps.download).toHaveBeenCalledOnce();
    expect(deps.markPresentMessage).toHaveBeenCalledWith(1, "/data/media/backfill/1.jpg");
    expect(deps.markPresentMedia).toHaveBeenCalledWith(1, null);
    expect(deps.enqueue).toHaveBeenCalledWith("analyze.image", {
      messageId: "1",
      tenantId: DEFAULT_TENANT_ID, // T2/T3: every payload is tenant-stamped
    });
    // Fix 2: markPresentMedia must be called AFTER enqueue (state gate is last)
    const enqueueOrder = (deps.enqueue as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markMediaOrder = (deps.markPresentMedia as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(enqueueOrder).toBeLessThan(markMediaOrder);
  });

  it("does NOT flip markPresentMedia when enqueue rejects — download_state stays pending (Fix 2)", async () => {
    const deps = baseDeps({
      enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable")),
    });
    await runBackfillBatch(deps as any, 10);
    // State gate must NOT have fired — the row stays pending for retry
    expect(deps.markPresentMedia).not.toHaveBeenCalled();
    // A transient attempt must be recorded so the row is retried
    expect(deps.recordAttempt).toHaveBeenCalledWith(
      1,
      expect.stringContaining("queue unavailable"),
    );
  });

  it("enqueues transcribe.voicenote for audio", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 2, mediaKind: "audio", waMessage: Buffer.from([1]) }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).toHaveBeenCalledWith("transcribe.voicenote", {
      messageId: "2",
      tenantId: DEFAULT_TENANT_ID,
    });
  });

  it("marks unrecoverable on a 404/NOT_FOUND download error", async () => {
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("media not found (404)")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("404"));
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("records a transient attempt (no state change) on a generic error", async () => {
    const deps = baseDeps({ download: vi.fn().mockRejectedValue(new Error("socket hiccup")) });
    await runBackfillBatch(deps as any, 10);
    expect(deps.recordAttempt).toHaveBeenCalledWith(1, expect.stringContaining("hiccup"));
    expect(deps.markUnrecoverable).not.toHaveBeenCalled();
  });

  it("skips a row whose blob is missing", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 3, mediaKind: "image", waMessage: null }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(3, expect.stringContaining("blob"));
  });

  it("excludes stickers from analysis enqueue", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 4, mediaKind: "sticker", waMessage: Buffer.from([1]) }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues analyze.video for video mediaKind", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 5, mediaKind: "video", waMessage: Buffer.from([1]) }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).toHaveBeenCalledWith("analyze.video", {
      messageId: "5",
      tenantId: DEFAULT_TENANT_ID,
    });
  });

  it("marks unrecoverable on a 410 download error", async () => {
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("resource gone (410)")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("410"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it("marks unrecoverable on a textual 'not found' download error (no status code)", async () => {
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("media not found")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("not found"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  // Baileys throws a Boom "Failed to fetch stream from <url>" with the real HTTP
  // status on err.output.statusCode — the message itself carries no code. With
  // reuploadRequest broken, 403 (expired signed URL) and 410 (CDN-GC'd blob) are
  // both terminal, so we must classify on the status, not the message text.
  it("marks unrecoverable on a Boom 403 (expired signature) whose message has no code", async () => {
    const boom = Object.assign(new Error("Failed to fetch stream from https://mmg/x"), {
      output: { statusCode: 403 },
    });
    const deps = baseDeps({ download: vi.fn().mockRejectedValue(boom) });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("403"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it("marks unrecoverable on a Boom 410 whose message has no code", async () => {
    const boom = Object.assign(new Error("Failed to fetch stream from https://mmg/x"), {
      output: { statusCode: 410 },
    });
    const deps = baseDeps({ download: vi.fn().mockRejectedValue(boom) });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("410"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it("marks unrecoverable on an axios-shaped error (status on response.status)", async () => {
    const axiosErr = Object.assign(new Error("Request failed"), { response: { status: 404 } });
    const deps = baseDeps({ download: vi.fn().mockRejectedValue(axiosErr) });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("404"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it("records a transient attempt on a Boom 5xx (server error, retryable)", async () => {
    const boom = Object.assign(new Error("Failed to fetch stream from https://mmg/x"), {
      output: { statusCode: 503 },
    });
    const deps = baseDeps({ download: vi.fn().mockRejectedValue(boom) });
    await runBackfillBatch(deps as any, 10);
    expect(deps.recordAttempt).toHaveBeenCalledWith(1, expect.stringContaining("503"));
    expect(deps.markUnrecoverable).not.toHaveBeenCalled();
  });

  it("sweeps expired rows before selecting the batch", async () => {
    const calls: string[] = [];
    const deps = baseDeps({
      sweepExpired: vi.fn(async () => {
        calls.push("sweep");
        return 2;
      }),
      selectPending: vi.fn(async () => {
        calls.push("select");
        return [];
      }),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.sweepExpired).toHaveBeenCalledOnce();
    expect(calls).toEqual(["sweep", "select"]); // sweep must run first
  });

  it("records transient attempt (not unrecoverable) when writeFile throws", async () => {
    const deps = baseDeps({
      writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.recordAttempt).toHaveBeenCalledWith(1, expect.stringContaining("disk full"));
    expect(deps.markUnrecoverable).not.toHaveBeenCalled();
  });

  // ── Log levels: expected media-CDN noise → debug, retries → info, infra → warn ──
  it("logs terminal 'gone' download failures at debug (not info/warn)", async () => {
    const log = logSpy();
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("media not found (404)")),
      log,
    });
    await runBackfillBatch(deps as any, 10);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("404"));
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs transient download failures at info (will retry)", async () => {
    const log = logSpy();
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("socket hiccup")),
      log,
    });
    await runBackfillBatch(deps as any, 10);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("hiccup"));
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs persist/infra failures at warn", async () => {
    const log = logSpy();
    const deps = baseDeps({
      writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
      log,
    });
    await runBackfillBatch(deps as any, 10);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("logs the expired-media sweep at debug (benign cleanup, not info)", async () => {
    const log = logSpy();
    const deps = baseDeps({
      sweepExpired: vi.fn().mockResolvedValue(3),
      selectPending: vi.fn().mockResolvedValue([]),
      log,
    });
    await runBackfillBatch(deps as any, 10);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("retired 3"));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("excluded chat: downloads + marks present but does NOT enqueue analysis", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([
          { messageId: 1, groupId: 9, mediaKind: "image", waMessage: Buffer.from([1]) },
        ]),
      isGroupIncluded: vi.fn().mockResolvedValue(false),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markPresentMessage).toHaveBeenCalled(); // captured
    expect(deps.enqueue).not.toHaveBeenCalled(); // not analyzed
    expect(deps.markPresentMedia).toHaveBeenCalled(); // capture completes even when not analyzed
  });

  it("included chat: still enqueues analysis", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([
          { messageId: 1, groupId: 9, mediaKind: "image", waMessage: Buffer.from([1]) },
        ]),
      isGroupIncluded: vi.fn().mockResolvedValue(true),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).toHaveBeenCalledWith(
      "analyze.image",
      expect.objectContaining({ messageId: "1" }),
    );
  });
});

describe("startBackfillLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-overlap guard: skips second tick while first is still running", async () => {
    vi.useFakeTimers();

    // Create a deferred that we control — selectPending won't resolve until we say so.
    let releaseBatch!: () => void;
    const blockingPromise = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockReturnValueOnce(blockingPromise.then(() => []))
        .mockResolvedValue([]),
    });

    const loop = startBackfillLoop(deps as any, { intervalMs: 1000, batchSize: 10 });

    // Advance past two intervals — both ticks fire but only the first gets through.
    await vi.advanceTimersByTimeAsync(2500);
    expect(deps.selectPending).toHaveBeenCalledTimes(1);

    // Release the first batch; advance again — now a second run can start.
    releaseBatch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.selectPending).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("stop() prevents further selectPending calls after stopping", async () => {
    vi.useFakeTimers();

    const deps = baseDeps({
      selectPending: vi.fn().mockResolvedValue([]),
    });

    const loop = startBackfillLoop(deps as any, { intervalMs: 1000, batchSize: 10 });

    await vi.advanceTimersByTimeAsync(1500);
    const callsBeforeStop = (deps.selectPending as ReturnType<typeof vi.fn>).mock.calls.length;

    loop.stop();

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.selectPending).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it("logs an unexpected batch error at warn", async () => {
    vi.useFakeTimers();
    const log = logSpy();
    const deps = baseDeps({
      selectPending: vi.fn().mockRejectedValue(new Error("boom")),
      log,
    });
    const loop = startBackfillLoop(deps as any, { intervalMs: 1000, batchSize: 10 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    loop.stop();
  });

  it("does NOT warn when an in-flight batch fails because stop() ended the pool", async () => {
    vi.useFakeTimers();
    const log = logSpy();

    // Block the first batch mid-flight, then reject it the way a closed pool would —
    // this is the shutdown race: stop() runs while a batch is still awaiting the pool.
    let rejectBatch!: (e: Error) => void;
    const blocking = new Promise<never>((_, reject) => {
      rejectBatch = reject;
    });
    const deps = baseDeps({
      selectPending: vi.fn().mockReturnValueOnce(blocking).mockResolvedValue([]),
      log,
    });

    const loop = startBackfillLoop(deps as any, { intervalMs: 1000, batchSize: 10 });
    await vi.advanceTimersByTimeAsync(1000); // first tick starts, awaits the pool

    loop.stop(); // shutdown — pool is about to be / has been ended
    rejectBatch(new Error("Cannot use a pool after calling end on the pool"));
    await vi.advanceTimersByTimeAsync(1);

    expect(log.warn).not.toHaveBeenCalled();
  });
});
