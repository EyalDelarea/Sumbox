/**
 * session.ts — Baileys WebSocket session management.
 *
 * Responsibilities:
 * - Load/persist auth state via useMultiFileAuthState under data/baileys-auth/
 * - Print a scannable QR on first link (via the `qrcode` library; raw string fallback)
 * - Auto-reconnect on dropped connection (unless logged out)
 * - Emit incoming group messages for the collector to process
 *
 * This module is intentionally thin and WhatsApp-specific so that everything
 * else (collector.ts, CLI) remains testable without a real socket.
 *
 * NOTE: T019 (live-account validation spike) is DEFERRED. This module is
 * implemented against the Baileys API as documented but has NOT been validated
 * against a real WhatsApp account in this task.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type Chat,
  type ConnectionState,
  type Contact,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { getLogger } from "../logging/log.js";
import { GroupSubjectThrottle } from "./group-subject-throttle.js";
import { createHistorySyncProgress, type HistorySyncProgress } from "./history-sync-progress.js";
import { type AllowlistSource, applyOutboundGuard } from "./outbound-guard.js";

const collectorLog = getLogger("collector");
const historySyncLog = getLogger("history-sync");
const diagLog = getLogger("diag-names");

export type SessionEvents = {
  message: [msg: WAMessage];
  qr: [qr: string];
  connected: [];
  disconnected: [];
  /** Terminal: WhatsApp invalidated the link — auth state must be deleted and re-linked. */
  "logged-out": [];
  /** WhatsApp contacts directory (saved names + push names) for name resolution. */
  contacts: [contacts: Contact[]];
  /** Chat/group directory entries (with subjects) delivered on history sync. */
  chats: [chats: Chat[]];
  /** Emitted per history-sync chunk — carries WhatsApp's own progress (0–100). */
  "history-progress": [
    info: { progress: number | null; isLatest: boolean; syncType: number | null; count: number },
  ];
};

/**
 * CollectorSession wraps a Baileys socket and provides a stable event interface.
 */
export class CollectorSession extends EventEmitter {
  private socket: WASocket | null = null;
  private authDir: string;
  private stopped = false;
  private storedMessages = 0;
  /** When false (default), the socket is hard-guarded to never send anything. */
  private allowSend: boolean;
  /** Collapses the per-batch history-sync flood into throttled progress + a summary. */
  private historyProgress: HistorySyncProgress;
  /** When true, request WhatsApp's full history sync on link (one-time bulk pull). */
  private syncFullHistory: boolean;
  /** When true, accept ALL history chunks incl. FULL (Baileys default drops FULL). */
  private acceptAllHistory: boolean;
  /** JIDs allowed to receive sends even while allowSend is false (see outbound-guard).
   *  Pass a resolver (production passes the /סיכום matcher's own DB resolver) so the
   *  guard re-reads it per send and a group enabled at runtime can reply without a
   *  restart; an array is a fixed set. */
  private readonly allowlist: AllowlistSource;
  /**
   * Per-JID throttle for group-subject lookups: dedupes concurrent queries and
   * arms a cooldown after an attempt that yields no usable name, so a burst of
   * messages from one unresolved group can't hammer WhatsApp's groupMetadata
   * into a `rate-overlimit` (429). 5-minute window is long enough to shed the
   * storm yet short enough to self-heal once the rate budget recovers.
   */
  private readonly groupSubjectThrottle = new GroupSubjectThrottle(5 * 60_000);

  constructor(
    authDir: string,
    allowSend = false,
    opts: {
      syncFullHistory?: boolean;
      acceptAllHistory?: boolean;
      allowlist?: string[] | AllowlistSource;
    } = {},
  ) {
    super();
    this.authDir = authDir;
    this.allowSend = allowSend;
    this.historyProgress = createHistorySyncProgress({
      log: (line) => historySyncLog.info(line),
    });
    this.syncFullHistory = opts.syncFullHistory ?? false;
    this.acceptAllHistory = opts.acceptAllHistory ?? false;
    this.allowlist = Array.isArray(opts.allowlist)
      ? new Set(opts.allowlist)
      : (opts.allowlist ?? new Set<string>());
  }

  /**
   * Send a plain-text message to a JID, optionally as a reply that quotes
   * another message. Only works for an allowlisted JID (or when allowSend is
   * true) — otherwise the outbound guard throws. Returns the sent message (so
   * the caller can quote it next time). Throws if the socket is not connected.
   */
  async sendText(
    jid: string,
    text: string,
    opts: { quoted?: WAMessage } = {},
  ): Promise<WAMessage | undefined> {
    const sock = this.socket;
    if (!sock) throw new Error("Cannot send: socket not connected.");
    return sock.sendMessage(jid, { text }, opts.quoted ? { quoted: opts.quoted } : undefined);
  }

  /**
   * React to a message with an emoji (e.g. ⏳ while working, ✅ when done). A
   * new reaction from the same account replaces the previous one, so ⏳→✅ is a
   * swap, not two reactions. Same allowlist guard as sendText.
   */
  async react(jid: string, key: WAMessage["key"], emoji: string): Promise<void> {
    const sock = this.socket;
    if (!sock) throw new Error("Cannot react: socket not connected.");
    await sock.sendMessage(jid, { react: { text: emoji, key } });
  }

  /**
   * Reconstruct a minimal quoted message from a stored message id + text, so we
   * can reply-quote a message we sent earlier but no longer hold in memory (e.g.
   * a previous summary, after a collector restart). Baileys derives the quoted
   * author from `fromMe`; we also set participant to our own JID when known.
   */
  quotedFrom(jid: string, waMessageId: string, text: string): WAMessage {
    return {
      key: { remoteJid: jid, fromMe: true, id: waMessageId, participant: this.socket?.user?.id },
      message: { conversation: text },
    } as WAMessage;
  }

  /** Total messages reported as stored (updated by caller via incrementStored). */
  get storedCount(): number {
    return this.storedMessages;
  }

  /**
   * True once stop() has been called. A 'close' during teardown still emits
   * 'disconnected', but it will NOT auto-reconnect — listeners use this to avoid
   * logging a misleading "will auto-reconnect" during graceful shutdown.
   */
  get isStopped(): boolean {
    return this.stopped;
  }

  incrementStored(): void {
    this.storedMessages++;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.socket?.end(undefined);
    } catch {
      // ignore
    }
    this.socket = null;
  }

  /**
   * Download the media payload (e.g. a voice note) for a received message as a
   * Buffer, via Baileys. Used by the collector to persist voice-note audio so
   * it can be transcribed. Throws if the socket is not connected.
   *
   * This is the WhatsApp-specific glue kept in the (thin, untested) session
   * module; the collector that calls it takes this as an injected function and
   * stays testable without a real socket.
   */
  async downloadMedia(msg: WAMessage): Promise<Buffer> {
    const sock = this.socket;
    if (!sock) {
      throw new Error("Cannot download media: socket not connected.");
    }
    const buf = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: makeSilentLogger() as never,
        reuploadRequest: sock.updateMediaMessage,
      },
    );
    return buf as Buffer;
  }

  /**
   * Fetch the subject (display name) of a WhatsApp group chat by JID.
   *
   * Thin session glue (untested, like downloadMedia): wraps
   * socket.groupMetadata(jid).subject. Throws if the socket is not connected.
   *
   * Routed through {@link groupSubjectThrottle} so concurrent lookups for the
   * same group collapse to one query and a failed/empty resolution is not
   * re-attempted for a cooldown window — the guard against the groupMetadata
   * `rate-overlimit` storm. Returns "" on any resolution failure (never throws
   * for a connected socket); the caller already treats "" as "no name".
   */
  async groupSubject(jid: string): Promise<string> {
    const sock = this.socket;
    if (!sock) {
      throw new Error("Cannot fetch group subject: socket not connected.");
    }
    return this.groupSubjectThrottle.resolve(jid, async (id) => {
      const md = await sock.groupMetadata(id);
      return md.subject ?? "";
    });
  }

  /** Baileys' lid<->pn mapping store, or null if the socket isn't connected. */
  private lidMapping(): {
    getLIDForPN(pn: string): Promise<string | null>;
    getPNForLID(lid: string): Promise<string | null>;
  } | null {
    const repo = (this.socket as unknown as { signalRepository?: { lidMapping?: unknown } } | null)
      ?.signalRepository?.lidMapping;
    return (repo as ReturnType<CollectorSession["lidMapping"]>) ?? null;
  }

  /**
   * Resolve the @lid identity for a phone (@s.whatsapp.net) JID via Baileys'
   * lid<->pn mapping, normalized (device suffix stripped). Returns null if
   * unknown or the socket isn't connected. Never throws.
   */
  async lidForPn(pn: string): Promise<string | null> {
    const lm = this.lidMapping();
    if (!lm) return null;
    try {
      const lid = await lm.getLIDForPN(pn);
      return lid ? jidNormalizedUser(lid) : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the phone (@s.whatsapp.net) identity for an @lid JID, normalized.
   * Returns null if unknown or the socket isn't connected. Never throws.
   */
  async pnForLid(lid: string): Promise<string | null> {
    const lm = this.lidMapping();
    if (!lm) return null;
    try {
      const pn = await lm.getPNForLID(lid);
      return pn ? jidNormalizedUser(pn) : null;
    } catch {
      return null;
    }
  }

  /**
   * Request WhatsApp to send older history for a chat.
   *
   * T010 — thin session glue (untested, like downloadMedia).
   * Wraps socket.fetchMessageHistory; throws if the socket is not connected.
   *
   * @param count    Number of messages to request.
   * @param anchorKey  The message anchor (paginate before this message).
   * @param anchorTsMs The anchor message timestamp in milliseconds.
   * @returns A request id string.
   */
  async fetchMessageHistory(
    count: number,
    anchorKey: { remoteJid: string; id: string; fromMe: boolean },
    anchorTsMs: number,
  ): Promise<string> {
    const sock = this.socket;
    if (!sock) {
      throw new Error("Cannot fetch message history: socket not connected.");
    }
    return sock.fetchMessageHistory(
      count,
      { remoteJid: anchorKey.remoteJid, id: anchorKey.id, fromMe: anchorKey.fromMe },
      anchorTsMs,
    );
  }

  /**
   * Wait for Baileys to deliver a 'messaging-history.set' event for the given chat JID,
   * and resolve with the messages contained in that event.
   *
   * T010 — thin session glue (untested, like downloadMedia).
   * Registers a one-time listener; always cleans up (resolve or timeout).
   *
   * @param chatJid   The group/chat JID to filter events by.
   * @param timeoutMs Resolve with [] if no event arrives within this budget.
   * @returns Array of WAMessages from the history batch, or [] on timeout.
   */
  async awaitHistorySync(chatJid: string, timeoutMs: number): Promise<WAMessage[]> {
    const sock = this.socket;
    if (!sock) {
      return [];
    }

    return new Promise<WAMessage[]>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        sock.ev.off("messaging-history.set", handler);
      };

      const handler = (data: { messages: WAMessage[]; isLatest?: boolean }) => {
        if (settled) return;
        // Filter messages belonging to this chat
        const relevant = data.messages.filter((m) => m.key?.remoteJid === chatJid);
        if (relevant.length === 0) return; // Not for our chat — keep waiting
        settled = true;
        cleanup();
        resolve(relevant);
      };

      sock.ev.on("messaging-history.set", handler);

      timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve([]);
        },
        Math.max(0, timeoutMs),
      );
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    // Ensure auth directory exists
    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const sock = makeWASocket({
      auth: state,
      // Forward-only by default (research R3). full-sync mode flips this to pull the
      // one-time bulk history WhatsApp pushes on link.
      syncFullHistory: this.syncFullHistory,
      // Do NOT announce presence/online on connect — stay an invisible observer
      // (also avoids stealing notifications from the phone). Safety guardrail.
      markOnlineOnConnect: false,
      // Print connection logs to stderr to keep stdout clean for QR/heartbeat
      logger: makeSilentLogger(),
      // Baileys' default shouldSyncHistoryMessage DROPS FULL-history chunks; in
      // full-sync mode accept everything so deep history is actually delivered.
      ...(this.acceptAllHistory ? { shouldSyncHistoryMessage: () => true } : {}),
    });

    // SAFETY: unless sending is explicitly enabled, neutralize all outbound
    // methods so the linked device can never send messages, receipts, or
    // presence. Belt-and-suspenders on top of markOnlineOnConnect.
    applyOutboundGuard(sock, this.allowSend, this.allowlist);

    this.socket = sock;

    // Persist credentials whenever they update (keeps session alive across restarts)
    sock.ev.on("creds.update", saveCreds);

    // Contacts directory — the only source for SAVED contact names / push names.
    // Forwarded for the collector to resolve 1:1 chat display names.
    sock.ev.on("contacts.upsert", (contacts: Contact[]) => {
      diagContacts("contacts.upsert", contacts);
      if (contacts.length > 0) this.emit("contacts", contacts);
    });
    sock.ev.on("contacts.update", (updates: Partial<Contact>[]) => {
      diagContacts("contacts.update", updates);
      const contacts = updates.filter((c): c is Contact => typeof c.id === "string");
      if (contacts.length > 0) this.emit("contacts", contacts);
    });

    // Handle connection state changes
    sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Emit QR for the CLI to print
        this.emit("qr", qr);
        printQr(qr);
      }

      if (connection === "open") {
        if (DIAG_NAMES) {
          diagLog.debug(
            "active — watching contacts.upsert/update + history.set (chats/contacts/lidPnMappings)",
          );
        }
        this.emit("connected");
      }

      if (connection === "close") {
        this.emit("disconnected");

        if (this.stopped) return;

        // Determine if we should reconnect
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          // T3: let the registry mark this tenant terminal (re-link required).
          this.emit("logged-out");
          collectorLog.error("WhatsApp session logged out. Delete data/baileys-auth/ and re-link.");
        } else {
          // Reconnect after a brief delay
          setTimeout(() => {
            this.connect().catch((err: unknown) => {
              collectorLog.error({ err }, "reconnect failed");
            });
          }, 3000);
        }
      }
    });

    // Forward incoming messages to listeners.
    // 'notify' = live messages; 'append' = messages WhatsApp queued while we were
    // offline, replayed on reconnect. Both are recovered — handleIncomingMessage
    // dedupes on dedupe_key, so replays/overlap are idempotent.
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;

      // Diagnostic: 'append' is the offline-replay channel — log how much arrives so
      // we can see whether WhatsApp actually delivers missed messages on reconnect.
      if (type === "append" && messages.length > 0) {
        historySyncLog.info({ count: messages.length }, "append: message(s)");
      }
      for (const msg of messages) {
        diagMessageKey(msg);
        this.emit("message", msg);
      }
    });

    // On (re)connect WhatsApp pushes a bounded recent-history batch. Persist it so
    // messages missed during downtime are recovered. syncFullHistory stays false, so
    // this is the recent window only; dedup makes overlap with live/append idempotent.
    sock.ev.on(
      "messaging-history.set",
      ({
        messages,
        chats,
        contacts,
        lidPnMappings,
        progress,
        isLatest,
        syncType,
      }: {
        messages: WAMessage[];
        chats: Chat[];
        contacts: Contact[];
        lidPnMappings?: { pn: string; lid: string }[];
        progress?: number | null;
        isLatest?: boolean;
        syncType?: number | null;
      }) => {
        diagHistory(chats, contacts, lidPnMappings);

        // The history payload also carries the chat + contact directory — the
        // only source for names of groups we can't fetch a subject for and for
        // saved 1:1 contact names. Forward both for resolution.
        if (chats?.length > 0) this.emit("chats", chats);
        if (contacts?.length > 0) this.emit("contacts", contacts);

        // Collapse the per-batch flood into a throttled progress line + summary
        // (instead of one log line per batch). The collector dedups the contents.
        this.historyProgress.record(messages.length);
        for (const msg of messages) {
          this.emit("message", msg);
        }

        // Surface WhatsApp's own sync progress (0–100) + completion flag so a
        // consumer (e.g. full-sync) can render a progress bar and auto-finish.
        this.emit("history-progress", {
          progress: progress ?? null,
          isLatest: isLatest ?? false,
          syncType: syncType ?? null,
          count: messages.length,
        });
      },
    );
  }
}

/**
 * Start a CollectorSession and return it.
 */
export async function startSession(
  authDir: string,
  allowSend = false,
  opts: {
    syncFullHistory?: boolean;
    acceptAllHistory?: boolean;
    allowlist?: string[] | AllowlistSource;
  } = {},
): Promise<CollectorSession> {
  const session = new CollectorSession(authDir, allowSend, opts);
  await session.start();
  return session;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Print a scannable QR code to the terminal.
 *
 * Uses the `qrcode` library (handles WhatsApp's long linking payload, which
 * `qrcode-terminal` cannot — it throws "bad rs block" on long input). Dynamic
 * import via a string-typed specifier resolves from this module's node_modules
 * and avoids static type resolution (no @types needed). `qrcode` is CommonJS,
 * so `toString` may sit on the namespace or on `.default` — handle both.
 * Falls back to the raw linking string if rendering fails for any reason.
 */
function printQr(qr: string): void {
  type QrToString = (text: string, opts: { type: "terminal"; small: boolean }) => Promise<string>;
  const specifier = "qrcode" as string;
  import(specifier)
    .then(async (mod: unknown) => {
      const m = mod as { toString?: QrToString; default?: { toString?: QrToString } };
      const toStringFn = m.toString ?? m.default?.toString;
      if (typeof toStringFn !== "function") {
        throw new Error("qrcode: toString() not found");
      }
      // The QR is terminal-only UX: write the ANSI art straight to stdout so it
      // bypasses the console guard (otherwise the escape codes flood the log stream).
      process.stdout.write(`${await toStringFn(qr, { type: "terminal", small: true })}\n`);
    })
    .catch((err: unknown) => {
      if (process.env["QR_DEBUG"] === "1") {
        collectorLog.error({ err }, "qrcode render failed");
      }
      process.stdout.write(`QR Code (scan with WhatsApp):\n${qr}\n`);
    });
}

// ---------------------------------------------------------------------------
// Name-resolution diagnostics (opt-in via SUMBOX_DIAG_NAMES=1)
// ---------------------------------------------------------------------------
// 1:1 (@s.whatsapp.net) chats weren't resolving while groups did. These gated
// probes report exactly what WhatsApp delivers — contact field coverage and the
// lid↔pn mapping — so we can see whether contacts arrive and how they're keyed
// before committing to a fix. No-ops unless the env flag is set.

const DIAG_NAMES = process.env.SUMBOX_DIAG_NAMES === "1";

let diagMsgKeysLogged = 0;
function diagMessageKey(msg: WAMessage): void {
  if (!DIAG_NAMES || diagMsgKeysLogged >= 8) return;
  const k = msg.key as {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
    fromMe?: boolean | null;
  };
  diagMsgKeysLogged++;
  diagLog.debug(
    {
      remoteJid: k.remoteJid ?? null,
      remoteJidAlt: k.remoteJidAlt ?? null,
      participant: k.participant ?? null,
      participantAlt: k.participantAlt ?? null,
      pushName: msg.pushName ?? null,
      fromMe: k.fromMe ?? null,
    },
    "msgkey",
  );
}

function diagContacts(source: string, contacts: Partial<Contact>[]): void {
  if (!DIAG_NAMES || contacts.length === 0) return;
  const has = (pred: (c: Partial<Contact>) => unknown) => contacts.filter(pred).length;
  diagLog.debug(
    {
      source,
      total: contacts.length,
      name: has((c) => c.name?.trim()),
      notify: has((c) => c.notify?.trim()),
      verifiedName: has((c) => c.verifiedName?.trim()),
      phoneNumber: has((c) => c.phoneNumber),
      "id@s": has((c) => c.id?.endsWith("@s.whatsapp.net")),
      "id@lid": has((c) => c.id?.endsWith("@lid")),
    },
    `contacts summary (${source})`,
  );
  for (const c of contacts.slice(0, 3)) {
    diagLog.debug(
      {
        id: c.id,
        lid: c.lid ?? null,
        phoneNumber: c.phoneNumber ?? null,
        name: c.name ?? null,
        notify: c.notify ?? null,
      },
      "contacts sample",
    );
  }
}

function diagHistory(
  chats: Chat[] | undefined,
  contacts: Contact[] | undefined,
  lidPnMappings: { pn: string; lid: string }[] | undefined,
): void {
  if (!DIAG_NAMES) return;
  diagLog.debug(
    {
      chats: chats?.length ?? 0,
      contacts: contacts?.length ?? 0,
      lidPnMappings: lidPnMappings?.length ?? 0,
    },
    "history.set",
  );
  for (const c of (contacts ?? []).slice(0, 4)) {
    diagLog.debug(
      {
        id: c.id,
        lid: c.lid ?? null,
        phoneNumber: c.phoneNumber ?? null,
        name: c.name ?? null,
        notify: c.notify ?? null,
        verifiedName: c.verifiedName ?? null,
      },
      "history.set contact",
    );
  }
  for (const ch of (chats ?? []).slice(0, 4)) {
    diagLog.debug({ id: ch.id, name: ch.name ?? null }, "history.set chat");
  }
  for (const m of (lidPnMappings ?? []).slice(0, 3)) {
    diagLog.debug({ pn: m.pn, lid: m.lid }, "history.set lidPn");
  }
}

/**
 * Create a minimal logger that suppresses all output (keeps stdout/stderr clean).
 * Baileys expects a pino-compatible logger.
 */
function makeSilentLogger() {
  const noop = () => {};
  return {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => makeSilentLogger(),
  };
}

// Re-export WAMessage for use by the CLI
export type { WAMessage };
