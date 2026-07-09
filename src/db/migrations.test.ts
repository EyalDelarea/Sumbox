import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "./migrate.js";

/**
 * Guard against duplicate migration numbers.
 *
 * Migrations are `<number>_<description>.ts` and run in ascending numeric order.
 * With several branches/agents in flight, two PRs can independently pick the
 * same next number; each is green alone, but once both merge `main` has a
 * duplicate. On a DB that already ran the first, the second then sorts before an
 * applied migration and node-pg-migrate (checkOrder defaults to true) aborts —
 * breaking deploys. This test runs against the PR's merged state in CI, so a
 * collision fails here BEFORE it reaches `main`. See CONTRIBUTING.md.
 */
describe("db migrations", () => {
  const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter(
    (f) => /^\d+_.+\.[cm]?[jt]s$/.test(f) && !/\.(test|spec)\./.test(f),
  );

  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("have unique numeric prefixes (no collisions from parallel branches)", () => {
    const byNumber = new Map<string, string[]>();
    for (const f of files) {
      const num = f.slice(0, f.indexOf("_"));
      byNumber.set(num, [...(byNumber.get(num) ?? []), f]);
    }
    const duplicates = [...byNumber.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([num, group]) => `${num}: ${group.join(", ")}`);

    expect(
      duplicates,
      `Duplicate migration number(s) — renumber one to the next free value (see CONTRIBUTING.md):\n${duplicates.join("\n")}`,
    ).toEqual([]);
  });
});
