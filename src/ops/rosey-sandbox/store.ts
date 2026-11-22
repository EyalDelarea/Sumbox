/**
 * store.ts — the sandbox's own reads and its ingest, against the SCRATCH
 * database only (the caller holds no other pool).
 *
 * Ingest is the collector's text path minus WhatsApp: upsertParticipant, then
 * normalize + insertMessages, exactly the calls handleIncomingMessage makes for
 * a live text message. Rosey then reads the stored row as she would in the
 * collector, where ingest always runs first.
 */

import type pg from "pg";
import { insertMessages } from "../../db/repositories/messages.js";
import { upsertParticipant } from "../../db/repositories/participants.js";
import { normalize } from "../../importer/normalize.js";

/** Someone who has written in the group: who the sandbox may post as. */
export type Member = {
  name: string;
  /** Their WhatsApp JID as stored on their latest message, if any. */
  jid: string | null;
  /** The device owner (their messages are from_me). */
  owner: boolean;
};

/** One stored message, as the chat view shows it. */
export type HistoryRow = {
  id: number;
  externalId: string | null;
  sentAt: Date;
  sender: string | null;
  fromMe: boolean;
  /** The text, a voice note's transcript, or a media item's description. */
  text: string | null;
  /** What `text` is. */
  source: "text" | "voice" | "media" | "none";
  /** Recorded in rosey_messages: one of Rosey's posts. */
  rosey: boolean;
  /** Recorded in aida_messages: one of @Aida's posts. */
  aida: boolean;
};

/** Named senders of the group (a display name that is not a bare JID), owner first. */
export async function listMembers(db: pg.Pool, groupId: number): Promise<Member[]> {
  const { rows } = await db.query<{ name: string; jid: string | null; owner: boolean }>(
    `SELECT DISTINCT ON (p.display_name)
            p.display_name AS name, m.sender_jid AS jid,
            bool_or(m.from_me IS TRUE) OVER (PARTITION BY p.display_name) AS owner
       FROM messages m JOIN participants p ON p.id = m.participant_id
      WHERE m.group_id = $1
        AND btrim(coalesce(p.display_name, '')) <> ''
        AND p.display_name NOT LIKE '%@%' AND p.display_name <> 'Unknown'
      ORDER BY p.display_name, m.sent_at DESC`,
    [groupId],
  );
  return rows.sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name));
}

export async function groupInfo(
  db: pg.Pool,
  groupId: number,
): Promise<{ name: string; jid: string } | null> {
  const { rows } = await db.query<{ name: string; whatsapp_id: string | null }>(
    `SELECT name, whatsapp_id FROM groups WHERE id = $1`,
    [groupId],
  );
  const r = rows[0];
  return r?.whatsapp_id ? { name: r.name, jid: r.whatsapp_id } : null;
}

/** The group's messages sent at or after `since`, oldest first. */
export async function history(db: pg.Pool, groupId: number, since: Date): Promise<HistoryRow[]> {
  const { rows } = await db.query<{
    id: string;
    external_id: string | null;
    sent_at: Date;
    sender: string | null;
    from_me: boolean | null;
    text_content: string | null;
    transcript: string | null;
    description: string | null;
    rosey: boolean;
    aida: boolean;
  }>(
    `SELECT m.id, m.external_id, m.sent_at, p.display_name AS sender, m.from_me,
            NULLIF(btrim(m.text_content), '') AS text_content,
            NULLIF(btrim(t.transcript), '') AS transcript,
            NULLIF(btrim(ma.description), '') AS description,
            (r.external_id IS NOT NULL) AS rosey, (a.external_id IS NOT NULL) AS aida
       FROM messages m
       LEFT JOIN participants p ON p.id = m.participant_id
       LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
       LEFT JOIN LATERAL (
         SELECT description FROM media_analyses
          WHERE message_id = m.id AND status = 'completed' ORDER BY id LIMIT 1
       ) ma ON true
       LEFT JOIN rosey_messages r ON r.group_id = m.group_id AND r.external_id = m.external_id
       LEFT JOIN aida_messages a ON a.group_id = m.group_id AND a.external_id = m.external_id
      WHERE m.group_id = $1 AND m.sent_at >= $2 AND m.message_type <> 'system'
      ORDER BY m.sent_at, m.id`,
    [groupId, since],
  );
  return rows.map((r) => {
    const [text, source]: [string | null, HistoryRow["source"]] = r.text_content
      ? [r.text_content, "text"]
      : r.transcript
        ? [r.transcript, "voice"]
        : r.description
          ? [r.description, "media"]
          : [null, "none"];
    return {
      id: Number(r.id),
      externalId: r.external_id,
      sentAt: r.sent_at,
      sender: r.sender,
      fromMe: r.from_me === true,
      text,
      source,
      rosey: r.rosey,
      aida: r.aida,
    };
  });
}

/** Store a text message as the collector would, before Rosey sees it. */
export async function ingestText(
  db: pg.Pool,
  input: {
    groupId: number;
    externalId: string;
    sender: string;
    senderJid: string | null;
    fromMe: boolean;
    text: string;
    sentAt: Date;
  },
): Promise<number> {
  const participantId = await upsertParticipant(db, input.sender);
  const [row] = normalize(
    [
      {
        senderName: input.sender,
        sentAt: input.sentAt,
        messageType: "text",
        textContent: input.text,
        mediaFilename: null,
        fromMe: input.fromMe,
        senderJid: input.senderJid,
      },
    ],
    { groupId: input.groupId, importId: null, source: "live", externalIds: [input.externalId] },
  );
  if (!row) throw new Error("message did not normalize");
  const { ids } = await insertMessages(db, [{ ...row, participantId }]);
  if (ids.length === 0) throw new Error("message was not stored");
  return Number(ids[0]);
}
