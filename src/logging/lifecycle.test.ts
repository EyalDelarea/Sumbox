import { afterEach, describe, expect, it } from "vitest";
import { logLifecycle } from "./lifecycle.js";
import { __resetBaseLoggerForTest, getLogger } from "./log.js";

afterEach(() => {
  __resetBaseLoggerForTest();
});

describe("logLifecycle", () => {
  it("is callable for each lifecycle event without throwing", () => {
    expect(() => {
      logLifecycle("boot", { proc: "serve" });
      logLifecycle("ready", { proc: "worker" });
      logLifecycle("shutdown", { proc: "serve", signal: "SIGINT" });
      logLifecycle("collector.connected");
      logLifecycle("collector.disconnected", { reason: "closed" });
      logLifecycle("reconnect.armed", { groups: 87 });
      logLifecycle("reconnect.done");
    }).not.toThrow();
  });

  it("uses the lifecycle component logger", () => {
    // The helper emits under the 'lifecycle' component; verify that binding exists.
    expect(getLogger("lifecycle").bindings().component).toBe("lifecycle");
  });
});
