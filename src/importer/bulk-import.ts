import fs from "node:fs";
import path from "node:path";
import type { JobBus } from "../jobs/job-bus.js";

const EXPORT_EXTENSIONS = new Set([".txt", ".zip"]);

export type EnqueueFolderResult = {
  enqueued: number;
};

/**
 * Scan `dir` for WhatsApp export files (.txt and .zip) and enqueue one
 * `import.file` job per matching file.
 *
 * @param bus   - The job bus to publish to.
 * @param dir   - Directory path to scan.
 * @param files - Optional injected file list (absolute paths). When omitted,
 *                the real filesystem is read (production path). Injecting the
 *                list enables unit tests without real FS I/O.
 * @returns     - { enqueued: number }
 */
export async function enqueueFolder(
  bus: JobBus,
  dir: string,
  files?: string[],
): Promise<EnqueueFolderResult> {
  const entries: string[] =
    files ??
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.join(dir, d.name));

  let enqueued = 0;

  for (const filePath of entries) {
    const ext = path.extname(filePath).toLowerCase();
    if (!EXPORT_EXTENSIONS.has(ext)) continue;

    // Derive a per-file group name from the filename so each export becomes its
    // own group. Without this, every file would import under an empty name and
    // collapse into a single merged group. (Folder mode has no --name.)
    const name = path.basename(filePath, path.extname(filePath));

    await bus.enqueue("import.file", { filePath, name });
    enqueued++;
  }

  return { enqueued };
}
