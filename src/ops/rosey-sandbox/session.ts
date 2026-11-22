/**
 * session.ts — one sandbox run: Rosey's REAL engine (rosey/engine.ts) over the
 * scratch copy of a group, with an in-memory sink where WhatsApp would be.
 *
 * - A message "posted" here is ingested into the scratch database the way the
 *   collector ingests a text message, then handed to the engine as a
 *   WhatsApp-shaped message: her capture gates, commands, list replies and the
 *   debounced suggestion pass (local Ollama) all run unchanged.
 * - Her sends land in the sink. A text reply is echoed back the way WhatsApp
 *   echoes the owner's own post (stored as from_me, then handed to the engine,
 *   where her own-echo guard must ignore it). A poll is kept in memory with its
 *   votes; a vote goes to the engine's real vote path.
 * - Send mode is forced to `live` and the sender is the sink, whatever .env
 *   says: nothing here can reach WhatsApp, because nothing here loads it
 *   (no-whatsapp.test.ts walks the import graph to prove it).
 * - The event log records what Rosey did and why: capture decisions and her own
 *   log lines (ids, outcomes and counts).
 */

import { randomBytes } from "node:crypto";
import type { WAMessage } from "@whiskeysockets/baileys";
import type pg from "pg";
import {
  listTasks,
  type RoseyTaskView,
  recordStatusEvent,
} from "../../db/repositories/rosey-tasks.js";
import type { CaptureResult } from "../../rosey/capture.js";
import { loadRoseyConfig, type RoseyConfig } from "../../rosey/config.js";
import { makeRoseyEngine, type RoseyLive } from "../../rosey/engine.js";
import type { RoseyPollSender } from "../../rosey/poll.js";
import type { RoseySender } from "../../rosey/reply.js";
import type { Generate } from "../../rosey/run.js";
import {
  groupInfo,
  type HistoryRow,
  history,
  ingestText,
  listMembers,
  type Member,
} from "./store.js";

/** How far back the chat view reaches. */
export const HISTORY_DAYS = 7;
/** Event log entries kept (oldest dropped). */
export const MAX_EVENTS = 300;

export type ListStyle = "text" | "poll";

export type SandboxEvent = {
  at: number;
  level: "info" | "warn" | "error";
  /** One line: what happened, with ids and reasons, never message text. */
  line: string;
};

export type SandboxPoll = {
  id: string;
  at: number;
  name: string;
  options: string[];
  quotedId: string | null;
  /** Each member's current ticks, by member index. */
  votes: Record<number, number[]>;
};

/** Why capture left a message alone, in a few words. */
const REASONS: Record<string, string> = {
  unmappable: "not a message Rosey reads",
  not_a_group: "not a group chat",
  allowlist_error: "her allowlist could not be read (fail closed)",
  not_enabled: "group not on her allowlist",
  unknown_group: "no group row",
  own_post: "her own post echoing back (own-echo guard)",
  stale: "older than 120 s (a replay)",
  aida_trigger: "addressed to @Aida — hers alone",
  aida_post: "one of @Aida's posts",
  aida_reply: "a reply to @Aida — hers alone",
  empty_tag: "a bare tag with nothing to do",
  not_ingested: "not stored by ingest",
  quote_not_ingested: "quotes a message that has no WhatsApp id — nothing applied",
};

function describeCapture(id: string, r: CaptureResult): string {
  const m = `message ${id.slice(-6)}`;
  switch (r.kind) {
    case "ignored":
      return `${m}: ignored — ${REASONS[r.reason] ?? r.reason}`;
    case "scheduled":
      return `${m}: chatter — suggestion pass scheduled after the quiet period`;
    case "command":
      return `${m}: command → ${JSON.stringify(r.outcome)}`;
    case "list":
      return `${m}: list request → ${JSON.stringify(r.outcome)}`;
  }
}

/** A WhatsApp-like message id. Sandbox-local: nothing it names is ever sent. */
export function sandboxMessageId(): string {
  return `3EB0${randomBytes(9).toString("hex").toUpperCase()}`;
}

function oneLine(obj: unknown): string {
  if (obj === undefined || obj === null) return "";
  const text = JSON.stringify(obj, (k, v) =>
    k === "err" && v && typeof v === "object" ? String((v as Error).message ?? v) : v,
  );
  return text === "{}" ? "" : ` ${text}`;
}

export type SandboxDeps = {
  /** The SCRATCH database — the only pool this session holds. */
  scratch: pg.Pool;
  groupId: number;
  /** Injectable for tests; defaults to the local Ollama model (via the engine). */
  generate?: Generate;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; the owner's echo grace (engine default otherwise). */
  ownEchoGraceMs?: number;
};

export class RoseySandbox {
  private engine: RoseyLive | null = null;
  private readonly cfg: RoseyConfig;
  private members: Member[] = [];
  private group: { name: string; jid: string } | null = null;
  private polls: SandboxPoll[] = [];
  /** Which message each message quoted (posted here), by external id. */
  private quotes = new Map<string, string>();
  private events: SandboxEvent[] = [];
  private passRunning = false;
  listStyle: ListStyle = "poll";

  constructor(private readonly deps: SandboxDeps) {
    // Her real config, but always on and always "live" into the sink.
    this.cfg = { ...loadRoseyConfig(deps.env ?? process.env), enabled: true, sendMode: "live" };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Load the group and start a fresh engine (also after a reset). */
  async start(): Promise<void> {
    this.engine?.stop();
    this.group = await groupInfo(this.deps.scratch, this.deps.groupId);
    if (!this.group) throw new Error(`group ${this.deps.groupId} has no WhatsApp id`);
    this.members = await listMembers(this.deps.scratch, this.deps.groupId);
    this.polls = [];
    this.quotes.clear();
    const log = (level: SandboxEvent["level"]) => (obj: unknown, msg?: string) =>
      this.event(level, `${msg ?? ""}${oneLine(obj)}`);
    this.engine = makeRoseyEngine({
      pool: this.deps.scratch,
      cfg: this.cfg,
      generate: this.deps.generate,
      ownEchoGraceMs: this.deps.ownEchoGraceMs,
      log: { info: log("info"), warn: log("warn"), error: log("error") },
      sender: this.textSink(),
      pollSender: this.pollSink(),
      listStyle: () => this.listStyle,
      newMessageId: sandboxMessageId,
      onCapture: (id, r) => this.event("info", describeCapture(id, r)),
    });
    this.event(
      "info",
      `sandbox ready: ${this.members.length} members, list style ${this.listStyle}`,
    );
  }

  stop(): void {
    this.engine?.stop();
    this.engine = null;
  }

  private live(): RoseyLive {
    if (!this.engine) throw new Error("sandbox is not running");
    return this.engine;
  }

  private event(level: SandboxEvent["level"], line: string): void {
    this.events.push({ at: Date.now(), level, line });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // ── The sink (where WhatsApp would be) ──────────────────────────────────────

  private owner(): Member {
    return this.members.find((m) => m.owner) ?? { name: "Sumbox", jid: null, owner: true };
  }

  private textSink(): RoseySender {
    return {
      sendText: async (_jid, _text, opts) => {
        const id = opts.messageId ?? sandboxMessageId();
        if (opts.quoted?.key?.id) this.quotes.set(id, opts.quoted.key.id);
        // WhatsApp echoes her post back as the owner's own message, after the send.
        setImmediate(() => {
          void this.deliver(this.owner(), _text, null, id).catch((err: unknown) =>
            this.event("error", `echo of her reply failed: ${(err as Error).message}`),
          );
        });
        return { key: { id } } as WAMessage;
      },
    };
  }

  private pollSink(): RoseyPollSender {
    return {
      sendPoll: async (_jid, poll, opts) => {
        this.polls.push({
          id: opts.messageId,
          at: Date.now(),
          name: poll.name,
          options: poll.options,
          quotedId: opts.quoted?.key?.id ?? null,
          votes: {},
        });
        return { key: { id: opts.messageId } } as WAMessage;
      },
    };
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private member(index: number): Member {
    const m = this.members[index];
    if (!m) throw new Error("unknown member");
    return m;
  }

  /** Store a message as ingest would, then hand it to Rosey. */
  private async deliver(
    m: Member,
    text: string,
    quotedId: string | null,
    externalId = sandboxMessageId(),
  ): Promise<string> {
    const group = this.group!;
    const seconds = Math.floor(Date.now() / 1000);
    await ingestText(this.deps.scratch, {
      groupId: this.deps.groupId,
      externalId,
      sender: m.name,
      senderJid: m.jid,
      fromMe: m.owner,
      text,
      sentAt: new Date(seconds * 1000),
    });
    if (quotedId) this.quotes.set(externalId, quotedId);
    const msg = {
      key: {
        id: externalId,
        remoteJid: group.jid,
        participant: m.jid ?? undefined,
        fromMe: m.owner,
      },
      pushName: m.name,
      messageTimestamp: seconds,
      message: quotedId
        ? { extendedTextMessage: { text, contextInfo: { stanzaId: quotedId } } }
        : { conversation: text },
    } as WAMessage;
    // Not awaited: an owner's command waits out the real echo grace, and a list
    // reply may wait on the queue. The page polls for what happens.
    void this.live()
      .onMessage(msg)
      .catch((err: unknown) => this.event("error", `capture threw: ${(err as Error).message}`));
    return externalId;
  }

  /** Post a message as one of the group's members, optionally quoting one. */
  async post(input: { member: number; text: string; quotedId?: string | null }): Promise<string> {
    const text = input.text.trim();
    if (!text) throw new Error("empty message");
    const m = this.member(input.member);
    this.event(
      "info",
      `you posted as ${m.owner ? "the owner" : "a member"}${input.quotedId ? ", quoting" : ""}`,
    );
    return this.deliver(m, text, input.quotedId ?? null);
  }

  /** Toggle one option of one of her polls for a member, then apply the vote. */
  async vote(input: { pollId: string; member: number; option: number }): Promise<void> {
    const poll = this.polls.find((p) => p.id === input.pollId);
    if (!poll) throw new Error("unknown poll");
    if (input.option < 0 || input.option >= poll.options.length) throw new Error("unknown option");
    const m = this.member(input.member);
    const mine = new Set(poll.votes[input.member] ?? []);
    if (mine.has(input.option)) mine.delete(input.option);
    else mine.add(input.option);
    poll.votes[input.member] = [...mine].sort((a, b) => a - b);
    await this.live().onPollVote({
      jid: this.group!.jid,
      pollId: poll.id,
      voter: m.jid ?? `member:${input.member}`,
      selected: poll.votes[input.member]!,
    });
  }

  /** Run the suggestion pass now (local Ollama); returns at once. */
  suggestNow(): void {
    if (this.passRunning) return;
    this.passRunning = true;
    this.event("info", "suggestion pass started (local model)");
    void this.live()
      .suggestNow(this.deps.groupId)
      .finally(() => {
        this.passRunning = false;
      });
  }

  /** Set an item's status by hand: the `rosey set` path (manual, D4's top layer). */
  async setStatus(taskId: number, status: "open" | "done" | "dropped"): Promise<void> {
    const r = await recordStatusEvent(this.deps.scratch, {
      taskId,
      status,
      source: "manual",
      groupId: this.deps.groupId,
    });
    this.event("info", `manual set #${taskId} → ${status}: ${JSON.stringify(r)}`);
  }

  // ── The view ────────────────────────────────────────────────────────────────

  async state(): Promise<{
    group: { name: string };
    members: Member[];
    history: (HistoryRow & { quotedId: string | null })[];
    polls: SandboxPoll[];
    tasks: RoseyTaskView[];
    events: SandboxEvent[];
    listStyle: ListStyle;
    passRunning: boolean;
    model: string;
  }> {
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
    const rows = await history(this.deps.scratch, this.deps.groupId, since);
    return {
      group: { name: this.group?.name ?? "" },
      members: this.members,
      history: rows.map((r) => ({
        ...r,
        quotedId: r.externalId ? (this.quotes.get(r.externalId) ?? null) : null,
      })),
      polls: this.polls,
      tasks: await listTasks(this.deps.scratch, this.deps.groupId, { includeClosed: true }),
      events: this.events,
      listStyle: this.listStyle,
      passRunning: this.passRunning,
      model: this.cfg.model,
    };
  }
}
