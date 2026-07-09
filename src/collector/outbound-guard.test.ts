import { describe, expect, it, vi } from "vitest";
import { applyOutboundGuard, HARD_BLOCKED, SILENCED } from "./outbound-guard.js";

/** A minimal fake Baileys socket exposing the methods the guard touches. */
function fakeSock() {
  const sock: Record<string, (...args: unknown[]) => unknown> = {};
  for (const m of [...HARD_BLOCKED, ...SILENCED]) {
    sock[m] = vi.fn(async () => "REAL_CALLED");
  }
  return sock;
}

describe("applyOutboundGuard", () => {
  describe("when sending is NOT allowed (default safe mode)", () => {
    it("hard-blocks message-sending methods by throwing", async () => {
      const sock = fakeSock();
      const original = sock["sendMessage"];
      applyOutboundGuard(sock as never, false);

      for (const m of HARD_BLOCKED) {
        await expect(sock[m]("jid", { text: "hi" })).rejects.toThrow(
          /disabled|blocked|WHATSAPP_ALLOW_SEND/i,
        );
      }
      // the real implementation was replaced, never invoked
      expect(original).not.toHaveBeenCalled();
    });

    it("silences presence/receipt methods to no-ops (no throw, no outbound)", async () => {
      const sock = fakeSock();
      const originals = SILENCED.map((m) => sock[m]);
      applyOutboundGuard(sock as never, false);

      for (const m of SILENCED) {
        await expect(sock[m]("jid")).resolves.toBeUndefined();
      }
      for (const orig of originals) {
        expect(orig).not.toHaveBeenCalled();
      }
    });
  });

  describe("when sending IS explicitly allowed", () => {
    it("leaves all methods untouched (original implementations run)", async () => {
      const sock = fakeSock();
      const originals = Object.fromEntries([...HARD_BLOCKED, ...SILENCED].map((m) => [m, sock[m]]));
      applyOutboundGuard(sock as never, true);

      for (const m of [...HARD_BLOCKED, ...SILENCED]) {
        await expect(sock[m]("jid")).resolves.toBe("REAL_CALLED");
        expect(originals[m]).toHaveBeenCalled();
      }
    });
  });

  describe("allowlist exception (blocked globally, but one JID may send)", () => {
    it("lets an allowlisted JID call through while others still throw", async () => {
      const sock = fakeSock();
      const original = sock["sendMessage"];
      applyOutboundGuard(sock as never, false, new Set(["123@g.us"]));

      // allowlisted target → the real implementation runs
      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).resolves.toBe("REAL_CALLED");
      expect(original).toHaveBeenCalledWith("123@g.us", { text: "hi" });

      // any other target → still blocked
      await expect(sock["sendMessage"]("999@g.us", { text: "no" })).rejects.toThrow(
        /disabled|blocked/i,
      );
    });
  });

  // The guard is applied once, at connect. A frozen Set meant a group enabled in
  // the UI afterwards matched in the matcher but threw here — the reply, the
  // error reply and the ⏳/✅ reactions all silently vanished until a restart
  // re-snapshotted it. The resolver form is what makes toggling take effect live.
  describe("live allowlist (resolver re-read on every send)", () => {
    it("a JID enabled after the guard was applied can send — no restart", async () => {
      const sock = fakeSock();
      const enabled = new Set<string>();
      applyOutboundGuard(sock as never, false, () => enabled);

      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).rejects.toThrow(/blocked/i);

      enabled.add("123@g.us"); // ← the UI toggle, mid-process
      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).resolves.toBe("REAL_CALLED");
    });

    it("a JID disabled after the guard was applied stops sending", async () => {
      const sock = fakeSock();
      const enabled = new Set(["123@g.us"]);
      applyOutboundGuard(sock as never, false, () => enabled);

      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).resolves.toBe("REAL_CALLED");

      enabled.delete("123@g.us");
      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).rejects.toThrow(/blocked/i);
    });

    it("resolves an async allowlist (the production DB resolver)", async () => {
      const sock = fakeSock();
      applyOutboundGuard(sock as never, false, async () => new Set(["123@g.us"]));

      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).resolves.toBe("REAL_CALLED");
      await expect(sock["sendMessage"]("999@g.us", { text: "no" })).rejects.toThrow(/blocked/i);
    });

    it("fails CLOSED when the resolver throws — a DB error must never send", async () => {
      const sock = fakeSock();
      const original = sock["sendMessage"];
      applyOutboundGuard(sock as never, false, () => {
        throw new Error("db down");
      });

      await expect(sock["sendMessage"]("123@g.us", { text: "hi" })).rejects.toThrow(/db down/);
      expect(original).not.toHaveBeenCalled();
    });

    it("is lazy — the resolver is never called unless a send is attempted", async () => {
      const sock = fakeSock();
      const resolve = vi.fn(() => new Set<string>());
      applyOutboundGuard(sock as never, false, resolve);

      await sock["sendPresenceUpdate"]("available");
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("tolerates a socket missing some methods (no crash)", () => {
    const partial: Record<string, unknown> = { sendMessage: async () => "x" };
    expect(() => applyOutboundGuard(partial as never, false)).not.toThrow();
  });
});
