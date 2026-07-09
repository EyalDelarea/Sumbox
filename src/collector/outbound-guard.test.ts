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

  it("tolerates a socket missing some methods (no crash)", () => {
    const partial: Record<string, unknown> = { sendMessage: async () => "x" };
    expect(() => applyOutboundGuard(partial as never, false)).not.toThrow();
  });
});
