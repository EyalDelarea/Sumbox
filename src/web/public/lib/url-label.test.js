/**
 * Tests for url-label.js — run with: npx vitest run src/web/public/lib/url-label.test.js
 */
import { describe, expect, it } from "vitest";
import { compactUrlLabel, isHttpUrl } from "./url-label.js";

const LONG_BOOKING =
  "https://www.booking.com/hotel/hu/aurea-apartman.html?label=gog235jc-10CAMoZ0IEaWdhckgOWANoaogBAZgBM7gBB8gBDNgBA&aid=356980&ucfs=1&checkin=2026-07-22&matching_block_id=1244231601_396431197_4_0_0&atlas_src=sr_iw_title";

describe("isHttpUrl", () => {
  it("accepts a whole-value http(s) URL", () => {
    expect(isHttpUrl(LONG_BOOKING)).toBe(true);
    expect(isHttpUrl("https://www.booking.com/Share-oxVP2Ag")).toBe(true);
  });
  it("rejects non-URLs, bare hosts, and text-with-a-url", () => {
    expect(isHttpUrl("booking.com")).toBe(false); // no scheme
    expect(isHttpUrl("היי תראו https://x.com")).toBe(false); // has spaces / text
    expect(isHttpUrl("just text")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false); // not http(s)
  });
});

describe("compactUrlLabel", () => {
  it("drops www + the entire query string, keeping host/path", () => {
    expect(compactUrlLabel(LONG_BOOKING)).toBe("booking.com/hotel/hu/aurea-apartman.html");
  });
  it("keeps a short share link as-is", () => {
    expect(compactUrlLabel("https://www.booking.com/Share-oxVP2Ag")).toBe(
      "booking.com/Share-oxVP2Ag",
    );
  });
  it("strips a trailing slash to just the host", () => {
    expect(compactUrlLabel("https://example.com/")).toBe("example.com");
  });
  it("truncates an overlong host/path with an ellipsis", () => {
    const label = compactUrlLabel(`https://example.com/${"a".repeat(80)}`);
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.endsWith("…")).toBe(true);
    expect(label.startsWith("example.com/")).toBe(true);
  });
});
