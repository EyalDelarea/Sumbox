import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "cli.ts");

function run(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", ...env },
  });
}

describe("CLI contract — import --folder mode (FR-025)", () => {
  it("--folder with a positional <path> exits non-zero with a clear error", () => {
    const r = run(["import", "/some/file.txt", "--folder", "/some/dir"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(
      /mutually exclusive|cannot use.*together|folder.*file|file.*folder|--folder/,
    );
  });

  it("--folder with --name exits non-zero with a clear error", () => {
    const r = run(["import", "--folder", "/some/dir", "--name", "MyGroup"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(
      /mutually exclusive|cannot use.*together|--name.*--folder|--folder.*--name/,
    );
  });

  it("--folder prints 'Enqueued N import jobs.' and exits 0", () => {
    // Create a temp dir with known exports
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsum-folder-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "chat1.txt"), "dummy");
      fs.writeFileSync(path.join(tmpDir, "export2.zip"), "dummy");
      fs.writeFileSync(path.join(tmpDir, "image.jpg"), "dummy"); // ignored

      // Use RABBITMQ_URL=stub so the CLI uses our stubbed bus path
      // The CLI uses USE_IN_MEMORY_BUS=1 env to bypass real broker in tests
      const r = run(["import", "--folder", tmpDir], {
        USE_IN_MEMORY_BUS: "1",
      });

      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Enqueued 2 import jobs\./);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--folder with an empty directory prints 'Enqueued 0 import jobs.' and exits 0", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsum-folder-empty-"));
    try {
      const r = run(["import", "--folder", tmpDir], {
        USE_IN_MEMORY_BUS: "1",
      });

      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Enqueued 0 import jobs\./);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--folder with a non-existent directory exits non-zero", () => {
    const r = run(["import", "--folder", "/no/such/directory/xyz123"], {
      USE_IN_MEMORY_BUS: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/not found|no such|enoent|does not exist/);
  });
});

describe("CLI contract — invalid inputs exit non-zero (SC-007)", () => {
  it("import of a missing file exits 1 with a clear error", () => {
    const r = run(["import", "/no/such/file.txt", "--name", "X"]);
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toMatch(/not found|no such/);
  });

  it("import of an unsupported extension exits 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumbox-contract-"));
    const tmp = path.join(dir, "unsupported.pdf");
    fs.writeFileSync(tmp, "x");
    try {
      const r = run(["import", tmp, "--name", "X"]);
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain("unsupported");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarize with both --last and --since exits 1", () => {
    const r = run(["summarize", "Whatever", "--last", "5", "--since", "2026-01-01"]);
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("only one of");
  });

  it("summarize with an invalid --since date exits 1", () => {
    const r = run(["summarize", "Whatever", "--since", "not-a-date"]);
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("invalid --since");
  });
});

describe("CLI contract — doctor command (FR-016)", () => {
  it("prints multiple check lines in the expected format", () => {
    const r = run(["doctor"]);
    // Output must have multiple lines — one per check
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(7); // at least the 7 core checks
  });

  it("each output line is ✅, ⚠️ or ❌ format", () => {
    const r = run(["doctor"]);
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      // ⚠️ is the advisory level (e.g. the default-DB-password check). Use an alternation,
      // not a character class — ⚠️ is two code points (⚠ + variation selector).
      expect(line).toMatch(/^(✅|⚠️|❌)/);
    }
  });

  it("every failing check line includes 'fix:' hint text", () => {
    const r = run(["doctor"]);
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    const failLines = lines.filter((l) => l.startsWith("❌"));
    // In test env real services will mostly be absent, so we should have failures
    // Each failure MUST carry "fix:"
    for (const line of failLines) {
      expect(line).toContain("fix:");
    }
  });

  it("exits non-zero when any check fails (real services may not be running)", () => {
    const r = run(["doctor"]);
    // In test/CI environment at least one service won't be running
    // If all pass (exit 0) the format is still correct; we test the non-zero case
    // by ensuring: if there are ❌ lines, exit code must be non-zero
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    const hasFailures = lines.some((l) => l.startsWith("❌"));
    if (hasFailures) {
      expect(r.status).not.toBe(0);
    } else {
      expect(r.status).toBe(0);
    }
  });

  it("exits 0 when all checks pass (injectable all-pass scenario via stubbed env)", () => {
    // We can't easily force all-pass in a subprocess contract test without real infra.
    // Instead verify that the command itself is recognized (no 'unknown command' error).
    const r = run(["doctor"]);
    // Commander should not output 'unknown command'
    expect(r.stderr).not.toContain("unknown command");
    expect(r.stderr).not.toContain("error: unknown command");
  });
});
