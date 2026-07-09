import { describe, expect, it } from "vitest";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { enqueueFolder } from "./bulk-import.js";

function makeBus() {
  const recorder = new InMemoryJobRunRecorder();
  return new InMemoryJobBus(recorder);
}

describe("enqueueFolder", () => {
  it("enqueues one import.file job per .txt file", async () => {
    const bus = makeBus();
    const files = ["/dir/chat1.txt", "/dir/chat2.txt", "/dir/chat3.txt"];

    const result = await enqueueFolder(bus, "/dir", files);

    expect(result.enqueued).toBe(3);
    expect(await bus.depth("import.file")).toBe(3);
  });

  it("enqueues one import.file job per .zip file", async () => {
    const bus = makeBus();
    const files = ["/dir/export1.zip", "/dir/export2.zip"];

    const result = await enqueueFolder(bus, "/dir", files);

    expect(result.enqueued).toBe(2);
  });

  it("enqueues jobs for both .txt and .zip, ignores other extensions", async () => {
    const bus = makeBus();
    const files = [
      "/dir/chat1.txt",
      "/dir/export.zip",
      "/dir/image.jpg", // ignored
      "/dir/notes.pdf", // ignored
      "/dir/readme.md", // ignored
      "/dir/data.csv", // ignored
    ];

    const result = await enqueueFolder(bus, "/dir", files);

    expect(result.enqueued).toBe(2);
    expect(await bus.depth("import.file")).toBe(2);
  });

  it("enqueues jobs with the correct filePath payloads", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const files = ["/dir/chat.txt", "/dir/export.zip", "/dir/skip.doc"];

    await enqueueFolder(bus, "/dir", files);

    const enqueued = recorder.enqueuedJobs;
    expect(enqueued).toHaveLength(2);
    const paths = enqueued.map((e) => (e.job.payload as { filePath: string }).filePath).sort();
    expect(paths).toEqual(["/dir/chat.txt", "/dir/export.zip"].sort());
  });

  it("derives a per-file group name from the filename so files don't merge", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const files = ["/dir/Family.txt", "/dir/Work Group.zip"];

    await enqueueFolder(bus, "/dir", files);

    const names = recorder.enqueuedJobs
      .map((e) => (e.job.payload as { name?: string }).name)
      .sort();
    expect(names).toEqual(["Family", "Work Group"]);
  });

  it("returns enqueued count 0 when no matching files", async () => {
    const bus = makeBus();
    const files = ["/dir/photo.jpg", "/dir/doc.docx"];

    const result = await enqueueFolder(bus, "/dir", files);

    expect(result.enqueued).toBe(0);
    expect(await bus.depth("import.file")).toBe(0);
  });

  it("returns enqueued count 0 for empty directory", async () => {
    const bus = makeBus();

    const result = await enqueueFolder(bus, "/dir", []);

    expect(result.enqueued).toBe(0);
  });

  it("ignores subdirectory entries (non-file paths without extension)", async () => {
    const bus = makeBus();
    // Subdirs would be listed without an audio extension
    const files = ["/dir/subdir", "/dir/chat.txt"];

    const result = await enqueueFolder(bus, "/dir", files);

    expect(result.enqueued).toBe(1);
  });

  it("is case-insensitive for extensions (.TXT, .ZIP)", async () => {
    const bus = makeBus();
    const files = ["/dir/CHAT.TXT", "/dir/EXPORT.ZIP", "/dir/mixed.Txt"];

    const result = await enqueueFolder(bus, "/dir", files);

    expect(result.enqueued).toBe(3);
  });
});
