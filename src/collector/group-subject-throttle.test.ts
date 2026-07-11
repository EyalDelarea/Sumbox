import { describe, expect, it } from "vitest";
import { GroupSubjectThrottle } from "./group-subject-throttle.js";

const JID = "120363406567322025@g.us";

/** A controllable clock: `now()` returns the current value; `advance` moves it. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("GroupSubjectThrottle", () => {
  it("collapses a concurrent burst for one JID into a single fetch (in-flight dedupe)", async () => {
    const clock = fakeClock();
    const throttle = new GroupSubjectThrottle(60_000, clock.now);
    let calls = 0;
    // A fetch that never resolves until we release it — models a slow query.
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    const fetch = () => {
      calls++;
      return gate;
    };

    // Fire 5 concurrent lookups for the SAME jid before any settles.
    const all = Promise.all([1, 2, 3, 4, 5].map(() => throttle.resolve(JID, fetch)));
    release("סומבוקס");
    const results = await all;

    expect(calls).toBe(1); // exactly one underlying groupMetadata call
    expect(results).toEqual(["סומבוקס", "סומבוקס", "סומבוקס", "סומבוקס", "סומבוקס"]);
  });

  it("does not query again within the cooldown after a throwing fetch", async () => {
    const clock = fakeClock();
    const throttle = new GroupSubjectThrottle(60_000, clock.now);
    let calls = 0;
    const fetch = () => {
      calls++;
      return Promise.reject(new Error("rate-overlimit"));
    };

    expect(await throttle.resolve(JID, fetch)).toBe(""); // first attempt: swallowed → ""
    expect(await throttle.resolve(JID, fetch)).toBe(""); // within cooldown → no query
    expect(await throttle.resolve(JID, fetch)).toBe("");
    expect(calls).toBe(1);
  });

  it("also arms the cooldown when the fetch returns an empty subject", async () => {
    const clock = fakeClock();
    const throttle = new GroupSubjectThrottle(60_000, clock.now);
    let calls = 0;
    const fetch = () => {
      calls++;
      return Promise.resolve("   "); // whitespace-only == no usable name
    };

    expect(await throttle.resolve(JID, fetch)).toBe("");
    expect(await throttle.resolve(JID, fetch)).toBe("");
    expect(calls).toBe(1);
  });

  it("retries once after the cooldown window elapses (self-healing)", async () => {
    const clock = fakeClock();
    const throttle = new GroupSubjectThrottle(60_000, clock.now);
    let calls = 0;
    const fetch = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("rate-overlimit")) : Promise.resolve("Family");
    };

    expect(await throttle.resolve(JID, fetch)).toBe(""); // fails, arms cooldown
    expect(await throttle.resolve(JID, fetch)).toBe(""); // still cooling down
    expect(calls).toBe(1);

    clock.advance(60_001); // cooldown expired
    expect(await throttle.resolve(JID, fetch)).toBe("Family"); // retries, succeeds
    expect(calls).toBe(2);
  });

  it("trims the resolved subject and does not arm a cooldown on success", async () => {
    const clock = fakeClock();
    const throttle = new GroupSubjectThrottle(60_000, clock.now);
    let calls = 0;
    const fetch = () => {
      calls++;
      return Promise.resolve("  Team  ");
    };

    expect(await throttle.resolve(JID, fetch)).toBe("Team");
    expect(await throttle.resolve(JID, fetch)).toBe("Team"); // no cooldown → queries again
    expect(calls).toBe(2);
  });

  it("clears the in-flight entry on rejection so the JID is not permanently stuck", async () => {
    const clock = fakeClock();
    const throttle = new GroupSubjectThrottle(60_000, clock.now);
    let calls = 0;
    const fetch = () => {
      calls++;
      return Promise.reject(new Error("boom"));
    };

    await throttle.resolve(JID, fetch); // rejects internally → cooldown armed
    clock.advance(60_001);
    await throttle.resolve(JID, fetch); // must be able to query again, not a stuck promise
    expect(calls).toBe(2);
  });
});
