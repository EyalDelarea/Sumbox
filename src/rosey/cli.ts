/**
 * cli.ts — `sumbox rosey …`: Rosey's local, read-mostly surface.
 *
 *   rosey list      --group <id> [--all]           the list (the view): tasks, then grocery
 *   rosey aggregate --group <id> [--days N] [--from-scratch]
 *                                                  read the chat, store suggestions
 *   rosey set       --task <id> [--status <s>] [--kind <k>]
 *                                                  manual status / kind (D4's top layer)
 *   rosey label     --group <id> --out <file> [--days N]
 *                                                  write a local labelling sheet
 *
 * Nothing here sends anything to WhatsApp, and every model call goes to the
 * local Ollama host.
 */

import fs from "node:fs";
import type { Command } from "commander";
import type pg from "pg";
import type { RoseyTaskView } from "../db/repositories/rosey-tasks.js";
import { resolveSenderName } from "../summarization/sender-name.js";
import { loadRoseyConfig } from "./config.js";
import { ITEM_KINDS, isItemKind, type RoseyItemKind } from "./kind.js";
import { isTaskStatus, type TaskStatus } from "./status.js";

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const { createDbClient } = await import("../db/client.js");
  const pool = createDbClient();
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function fail(cmd: string, err: unknown): never {
  process.stderr.write(`Error: rosey ${cmd} failed: ${(err as Error).message}\n`);
  process.exit(1);
}

export function renderTaskLine(t: RoseyTaskView): string {
  const when = t.raisedAt.toISOString().slice(0, 10);
  const who = t.raisedBy ? resolveSenderName(t.raisedBy) : "?";
  return `  #${t.id}  [${t.status}]  ${t.title}   — ${who}, ${when} (msg:${t.sourceMessageId})`;
}

const SECTIONS: ReadonlyArray<[RoseyItemKind, string]> = [
  ["task", "Tasks"],
  ["grocery", "Grocery"],
];
const STATUS_ORDER = ["open", "suggested", "done", "dropped"] as const;

/** The list view: one section per kind (tasks first), each grouped by status. */
export function renderTaskList(tasks: readonly RoseyTaskView[]): string {
  const out: string[] = [];
  for (const [kind, label] of SECTIONS) {
    const ofKind = tasks.filter((t) => t.kind === kind);
    if (ofKind.length === 0) continue;
    out.push("", `── ${label} (${ofKind.length}) ──`);
    for (const status of STATUS_ORDER) {
      const group = ofKind.filter((t) => t.status === status);
      if (group.length === 0) continue;
      out.push(`${status} (${group.length})`);
      for (const t of group) out.push(renderTaskLine(t));
    }
  }
  return `${out.join("\n")}\n`;
}

type ManualStatus = Exclude<TaskStatus, "suggested">;

/** `rosey set`'s options: a status, a kind, or both — never neither. */
export function parseSetOptions(o: { status?: string; kind?: string }): {
  status?: ManualStatus;
  kind?: RoseyItemKind;
} {
  if (o.status === undefined && o.kind === undefined) {
    throw new Error("give --status or --kind (or both)");
  }
  const out: { status?: ManualStatus; kind?: RoseyItemKind } = {};
  if (o.status !== undefined) {
    if (!isTaskStatus(o.status) || o.status === "suggested") {
      throw new Error("--status must be one of: open, done, dropped");
    }
    out.status = o.status;
  }
  if (o.kind !== undefined) {
    if (!isItemKind(o.kind)) throw new Error(`--kind must be one of: ${ITEM_KINDS.join(", ")}`);
    out.kind = o.kind;
  }
  return out;
}

export function registerRoseyCommands(program: Command): void {
  const rosey = program
    .command("rosey")
    .description("Rosey (@Rosey / @רוזי), the task bot — local view and backfill; never sends");

  rosey
    .command("list")
    .description(
      "Show a group's list — tasks, then grocery items (open and suggested; --all adds closed)",
    )
    .requiredOption("--group <id>", "Group id")
    .option("--all", "Include done and dropped tasks")
    .action(async (o: { group: string; all?: boolean }) => {
      try {
        const groupId = positiveInt(o.group, "--group");
        await withPool(async (pool) => {
          const { listTasks } = await import("../db/repositories/rosey-tasks.js");
          const tasks = await listTasks(pool, groupId, { includeClosed: o.all === true });
          if (tasks.length === 0) {
            process.stdout.write("No tasks for this group.\n");
            return;
          }
          process.stdout.write(renderTaskList(tasks));
          process.stdout.write(
            "\nConfirm a suggestion: rosey set --task <id> --status open  (or done / dropped)\n" +
              "Move an item between the lists: rosey set --task <id> --kind grocery  (or task)\n",
          );
        });
      } catch (err) {
        fail("list", err);
      }
    });

  rosey
    .command("aggregate")
    .description("Read the chat with the local model and store suggested tasks")
    .requiredOption("--group <id>", "Group id")
    .option("--days <n>", "Read messages sent within this many days", "90")
    .option("--from-scratch", "Ignore the incremental cursor and re-read the whole window")
    .action(async (o: { group: string; days: string; fromScratch?: boolean }) => {
      try {
        const groupId = positiveInt(o.group, "--group");
        const days = positiveInt(o.days, "--days");
        await withPool(async (pool) => {
          const { makeGenerate, runAggregation } = await import("./run.js");
          const cfg = loadRoseyConfig();
          const t0 = Date.now();
          const { report, tagged, cursorAdvanced } = await runAggregation(pool, groupId, {
            cfg,
            generate: makeGenerate(cfg),
            days,
            fromScratch: o.fromScratch === true,
            onBatchError: (err, b) =>
              process.stderr.write(
                `  batch ${b.index} (${b.size} messages) failed: ${(err as Error).message}\n`,
              ),
            onCommandError: (err, messageId) =>
              process.stderr.write(
                `  command in message ${messageId} failed: ${(err as Error).message}\n`,
              ),
          });
          process.stdout.write(
            `${JSON.stringify({ groupId, days, model: cfg.model, seconds: Math.round((Date.now() - t0) / 1000), cursorAdvanced, ...report, tagged }, null, 2)}\n`,
          );
          if (!cursorAdvanced) process.exitCode = 2;
        });
      } catch (err) {
        fail("aggregate", err);
      }
    });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    rosey
      .command(name)
      .description(
        enabled
          ? "Let Rosey capture tasks live in a group (her own 'rosey' allowlist; needs ROSEY_ENABLED=true)"
          : "Stop Rosey capturing tasks live in a group (stored tasks are kept)",
      )
      .requiredOption("--group <id>", "Group id")
      .action(async (o: { group: string }) => {
        try {
          const groupId = positiveInt(o.group, "--group");
          await withPool(async (pool) => {
            const { setRoseyEnabled } = await import("./run.js");
            await setRoseyEnabled(pool, groupId, enabled);
            process.stdout.write(
              `rosey ${enabled ? "enabled" : "disabled"} for group ${groupId}\n`,
            );
          });
        } catch (err) {
          fail(name, err);
        }
      });
  }

  rosey
    .command("set")
    .description(
      "Set an item's status and/or kind by hand (manual — the top layer of D4; a rerun never undoes it)",
    )
    .requiredOption("--task <id>", "Task id (from rosey list)")
    .option("--status <status>", "open | done | dropped")
    .option("--kind <kind>", "task | grocery")
    .action(async (o: { task: string; status?: string; kind?: string }) => {
      try {
        const taskId = positiveInt(o.task, "--task");
        const { status, kind } = parseSetOptions(o);
        await withPool(async (pool) => {
          const { recordStatusEvent, setTaskKind } = await import(
            "../db/repositories/rosey-tasks.js"
          );
          if (kind) {
            const k = await setTaskKind(pool, taskId, kind);
            if (!k.found) throw new Error(`no task #${taskId}`);
            process.stdout.write(
              k.previous === k.current
                ? `#${taskId} is already ${k.current}\n`
                : `#${taskId}: ${k.previous} → ${k.current}\n`,
            );
          }
          if (status) {
            const r = await recordStatusEvent(pool, { taskId, status, source: "manual" });
            if (!r.found) throw new Error(`no task #${taskId}`);
            process.stdout.write(
              r.applied
                ? `#${taskId}: ${r.previous} → ${r.current}\n`
                : `#${taskId} is already ${r.current}\n`,
            );
          }
        });
      } catch (err) {
        fail("set", err);
      }
    });

  rosey
    .command("label")
    .description("Write a local HTML sheet for labelling extraction accuracy (contains chat text)")
    .requiredOption("--group <id>", "Group id")
    .requiredOption("--out <file>", "Where to write the sheet (keep it on this machine)")
    .option("--days <n>", "Messages sent within this many days", "90")
    .action(async (o: { group: string; out: string; days: string }) => {
      try {
        const groupId = positiveInt(o.group, "--group");
        const days = positiveInt(o.days, "--days");
        await withPool(async (pool) => {
          const { listTasks, selectSourceMessages } = await import(
            "../db/repositories/rosey-tasks.js"
          );
          const { renderLabelSheet } = await import("./label-sheet.js");
          const tasks = await listTasks(pool, groupId, { includeClosed: true });
          const messages = await selectSourceMessages(pool, groupId, {
            sentSince: new Date(Date.now() - days * 86_400_000),
            changedSince: null,
          });
          fs.writeFileSync(o.out, renderLabelSheet({ groupId, tasks, messages }));
          process.stdout.write(
            `Wrote ${tasks.length} task(s) and ${messages.length} message(s) to ${o.out} — it contains chat text; keep it local.\n`,
          );
        });
      } catch (err) {
        fail("label", err);
      }
    });
}
