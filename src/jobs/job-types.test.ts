import { describe, expect, it } from "vitest";
import { ALL_JOB_TYPES, JOB_DESCRIPTORS, type JobType } from "./job-types.js";

describe("JOB_DESCRIPTORS", () => {
  it("derives ALL_JOB_TYPES from the table, in order, with a descriptor for each", () => {
    expect(ALL_JOB_TYPES).toEqual([
      "import.file",
      "transcribe.voicenote",
      "analyze.image",
      "analyze.video",
      "summarize.group",
      "summarize.total",
    ]);
    for (const t of ALL_JOB_TYPES) {
      expect(JOB_DESCRIPTORS[t]).toBeDefined();
    }
  });

  it("pins the prefetch policy — 'one' for the slow GPU/LLM jobs, 'concurrency' for import", () => {
    const prefetchOne = ALL_JOB_TYPES.filter((t) => JOB_DESCRIPTORS[t].prefetch === "one");
    expect(new Set(prefetchOne)).toEqual(
      new Set<JobType>([
        "transcribe.voicenote",
        "analyze.image",
        "analyze.video",
        "summarize.group",
        "summarize.total",
      ]),
    );
    expect(JOB_DESCRIPTORS["import.file"].prefetch).toBe("concurrency");
  });

  it("pins the Ollama serialization gate — the 4 Ollama-backed jobs, not audio/import", () => {
    const usesOllama = ALL_JOB_TYPES.filter((t) => JOB_DESCRIPTORS[t].usesOllama);
    expect(new Set(usesOllama)).toEqual(
      new Set<JobType>(["analyze.image", "analyze.video", "summarize.group", "summarize.total"]),
    );
    expect(JOB_DESCRIPTORS["transcribe.voicenote"].usesOllama).toBe(false);
    expect(JOB_DESCRIPTORS["import.file"].usesOllama).toBe(false);
  });

  it("pins the metrics opLabel for each type", () => {
    expect(JOB_DESCRIPTORS["import.file"].opLabel).toBe("import");
    expect(JOB_DESCRIPTORS["transcribe.voicenote"].opLabel).toBe("audio");
    expect(JOB_DESCRIPTORS["analyze.image"].opLabel).toBe("image");
    expect(JOB_DESCRIPTORS["analyze.video"].opLabel).toBe("video");
    expect(JOB_DESCRIPTORS["summarize.group"].opLabel).toBe("summary");
    expect(JOB_DESCRIPTORS["summarize.total"].opLabel).toBe("summary");
  });
});
