/**
 * Tests for open-state.js — run with:
 *   npx vitest run src/web/public/lib/open-state.test.js
 */
import { describe, it, expect } from "vitest";
import {
  shouldShowUpdatingChip,
  shouldShowStreamError,
  streamProducedNewSummary,
  shouldStartBackgroundRefresh,
} from "./open-state.js";

// ─── shouldShowUpdatingChip ───────────────────────────────────────────────────

describe("shouldShowUpdatingChip", () => {
  it("shows chip when cached summary present and stream is in flight", () => {
    expect(shouldShowUpdatingChip(true, "streaming")).toBe(true);
  });

  it("hides chip when no cached summary and stream is in flight (cold open)", () => {
    expect(shouldShowUpdatingChip(false, "streaming")).toBe(false);
  });

  it("hides chip when cached present but stream is done", () => {
    expect(shouldShowUpdatingChip(true, "done")).toBe(false);
  });

  it("hides chip when cached present but stream returned cache-hit", () => {
    expect(shouldShowUpdatingChip(true, "cached")).toBe(false);
  });

  it("hides chip when cached present but stream returned empty", () => {
    expect(shouldShowUpdatingChip(true, "empty")).toBe(false);
  });

  it("hides chip when cached present but stream errored", () => {
    expect(shouldShowUpdatingChip(true, "error")).toBe(false);
  });

  it("hides chip when phase is idle", () => {
    expect(shouldShowUpdatingChip(true, "idle")).toBe(false);
  });

  it("hides chip when no cached summary and idle", () => {
    expect(shouldShowUpdatingChip(false, "idle")).toBe(false);
  });
});

// ─── shouldShowStreamError ────────────────────────────────────────────────────

describe("shouldShowStreamError", () => {
  it("shows error when no cached summary and phase is error (cold open)", () => {
    expect(shouldShowStreamError(false, "error")).toBe(true);
  });

  it("suppresses error when cached summary is present (keep cached content)", () => {
    expect(shouldShowStreamError(true, "error")).toBe(false);
  });

  it("returns false for non-error phase regardless of cache", () => {
    expect(shouldShowStreamError(false, "done")).toBe(false);
    expect(shouldShowStreamError(true, "done")).toBe(false);
    expect(shouldShowStreamError(false, "streaming")).toBe(false);
  });
});

// ─── shouldStartBackgroundRefresh ────────────────────────────────────────────

describe("shouldStartBackgroundRefresh", () => {
  it("returns true when cached summary present, current group matches, and no refresh started", () => {
    expect(shouldStartBackgroundRefresh({
      hasCached: true,
      openedGroup: "GroupA",
      currentDetailGroup: "GroupA",
      backgroundRefreshStarted: false,
    })).toBe(true);
  });

  it("returns false when no cached summary (cold open — no background refresh needed)", () => {
    expect(shouldStartBackgroundRefresh({
      hasCached: false,
      openedGroup: "GroupA",
      currentDetailGroup: "GroupA",
      backgroundRefreshStarted: false,
    })).toBe(false);
  });

  it("returns false when user has navigated to a different group", () => {
    expect(shouldStartBackgroundRefresh({
      hasCached: true,
      openedGroup: "GroupA",
      currentDetailGroup: "GroupB",
      backgroundRefreshStarted: false,
    })).toBe(false);
  });

  it("returns false when user has navigated away entirely (currentDetailGroup is null)", () => {
    expect(shouldStartBackgroundRefresh({
      hasCached: true,
      openedGroup: "GroupA",
      currentDetailGroup: null,
      backgroundRefreshStarted: false,
    })).toBe(false);
  });

  it("returns false when background refresh already started (only one per open)", () => {
    expect(shouldStartBackgroundRefresh({
      hasCached: true,
      openedGroup: "GroupA",
      currentDetailGroup: "GroupA",
      backgroundRefreshStarted: true,
    })).toBe(false);
  });
});

// ─── streamProducedNewSummary ─────────────────────────────────────────────────

describe("streamProducedNewSummary", () => {
  it("returns true when phase is done (new summary generated)", () => {
    expect(streamProducedNewSummary("done")).toBe(true);
  });

  it("returns false for cached phase (no new messages)", () => {
    expect(streamProducedNewSummary("cached")).toBe(false);
  });

  it("returns false for empty phase (no messages at all)", () => {
    expect(streamProducedNewSummary("empty")).toBe(false);
  });

  it("returns false for error phase", () => {
    expect(streamProducedNewSummary("error")).toBe(false);
  });

  it("returns false for streaming phase (not yet settled)", () => {
    expect(streamProducedNewSummary("streaming")).toBe(false);
  });

  it("returns false for idle phase", () => {
    expect(streamProducedNewSummary("idle")).toBe(false);
  });
});
