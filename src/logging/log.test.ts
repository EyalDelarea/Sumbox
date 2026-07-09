import { afterEach, describe, expect, it } from "vitest";
import { __resetBaseLoggerForTest, getBaseLogger, getLogger } from "./log.js";

afterEach(() => {
  __resetBaseLoggerForTest();
});

describe("getLogger / singleton base logger", () => {
  it("tags every line with the component binding", () => {
    const log = getLogger("collector");
    expect(log.bindings().component).toBe("collector");
  });

  it("composes component with further child context (e.g. jobId)", () => {
    const log = getLogger("worker").child({ jobId: "abc", jobType: "summarize.group" });
    const b = log.bindings();
    expect(b.component).toBe("worker");
    expect(b.jobId).toBe("abc");
    expect(b.jobType).toBe("summarize.group");
  });

  it("constructs the base logger exactly once across many getLogger calls", () => {
    const first = getBaseLogger();
    getLogger("a");
    getLogger("b");
    const again = getBaseLogger();
    expect(again).toBe(first);
  });

  it("__resetBaseLoggerForTest forces a fresh base instance", () => {
    const first = getBaseLogger();
    __resetBaseLoggerForTest();
    const second = getBaseLogger();
    expect(second).not.toBe(first);
  });
});
