import type http from "node:http";
import {
  correctMemory,
  listMemoriesForReview,
  type MemoryType,
  revokeMemory,
} from "../../db/repositories/aida-memory.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

/**
 * memories.ts — the cleanup surface for what @Aida believes.
 *
 * GET    /api/memories                — everything on file, filterable
 * POST   /api/memories/correct        — replace a belief with your wording, and say why
 * POST   /api/memories/revoke         — withdraw one
 *
 * Post-hoc cleanup is the entire safety model for memory: no filter prevents a
 * bad belief being written, and what was accepted instead was a place a human
 * could find one and take it back. These three endpoints are that place.
 *
 * NEITHER WRITE DELETES ANYTHING. A correction appends and marks; a revoke
 * stamps. The words this returns to the UI matter for the same reason — a button
 * labelled "delete" over a row that survives would be the interface lying about
 * its own behaviour.
 *
 * Every write names the group as well as the memory. The repository requires it
 * so a withdrawal cannot walk out of the chat it belongs to, and the id alone is
 * not enough: the four memory tables have four independent sequences, so a low id
 * exists in all of them.
 */

const MEMORY_TYPES: readonly MemoryType[] = ["episodic", "semantic", "relational", "self_state"];

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseMemoryType(raw: unknown): MemoryType | null {
  return typeof raw === "string" && (MEMORY_TYPES as readonly string[]).includes(raw)
    ? (raw as MemoryType)
    : null;
}

function parsePositiveInt(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function handleMemories(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/memories") {
    return await getMemories(url, res, deps);
  }
  if (req.method === "POST" && url.pathname === "/api/memories/correct") {
    return await postCorrect(req, res, deps);
  }
  if (req.method === "POST" && url.pathname === "/api/memories/revoke") {
    return await postRevoke(req, res, deps);
  }
  json(res, 405, { error: "Method not allowed." });
}

/**
 * GET /api/memories?group=<id>&type=<memoryType>&withdrawn=1
 *
 * `withdrawn` is opt-in on the query string, mirroring the repository: the
 * default answers "what does she believe now", and a default that included
 * withdrawn beliefs would make revoking decorative.
 */
async function getMemories(url: URL, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const groupRaw = url.searchParams.get("group");
  const typeRaw = url.searchParams.get("type");
  const groupId = groupRaw === null ? undefined : (parsePositiveInt(groupRaw) ?? undefined);
  const memoryType = typeRaw === null ? undefined : (parseMemoryType(typeRaw) ?? undefined);
  // A malformed filter is refused rather than ignored: silently widening the list
  // past what the operator asked for is the wrong direction on this screen.
  if (groupRaw !== null && groupId === undefined) {
    return json(res, 400, { error: "Malformed group." });
  }
  if (typeRaw !== null && memoryType === undefined) {
    return json(res, 400, { error: "Unknown memory type." });
  }

  try {
    const rows = await listMemoriesForReview(deps.pool, {
      groupId,
      memoryType,
      includeWithdrawn: url.searchParams.get("withdrawn") === "1",
    });
    json(
      res,
      200,
      rows.map((r) => ({
        id: r.id,
        memoryType: r.memoryType,
        groupId: r.groupId,
        groupName: r.groupName,
        content: r.content,
        facet: r.facet,
        observedAt: r.observedAt.toISOString(),
        supportingEvidence: r.supportingEvidence,
        contradictingEvidence: r.contradictingEvidence,
        // The note's presence is what marks a row as human-written; the UI needs
        // both the flag and the text.
        correctionNote: r.correctionNote,
        byHuman: r.correctionNote !== null,
        revoked: r.revokedAt !== null,
        superseded: r.supersededById !== null,
        // So the UI can open the conversation on the message in one tap.
        sourceMessageId: r.firstSourceMessageId,
      })),
    );
  } catch {
    json(res, 500, { error: "Failed to load memories." });
  }
}

/** POST /api/memories/correct — { memoryType, groupId, memoryId, content, note } */
async function postCorrect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) return json(res, 400, { error: "Malformed body." });

  const memoryType = parseMemoryType(body.memoryType);
  const groupId = parsePositiveInt(body.groupId);
  const memoryId = parsePositiveInt(body.memoryId);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (memoryType === null || groupId === null || memoryId === null) {
    return json(res, 400, { error: "Malformed memory reference." });
  }
  if (content === "") return json(res, 400, { error: "Correction is empty." });
  // Refused here as well as in the repository. The note is the only thing marking
  // a row as human-written, so a UI that forgot the field would silently produce
  // corrections indistinguishable from her own conclusions.
  if (note === "") return json(res, 400, { error: "A correction must say why." });

  try {
    const outcome = await correctMemory(deps.pool, {
      memoryType,
      groupId,
      memoryId,
      content,
      note,
    });
    if (outcome.ok) return json(res, 200, { memoryId: outcome.memoryId });
    return json(res, outcome.reason === "not_found" ? 404 : 409, { error: outcome.reason });
  } catch {
    json(res, 500, { error: "Failed to correct memory." });
  }
}

/** POST /api/memories/revoke — { memoryType, groupId, memoryId } */
async function postRevoke(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) return json(res, 400, { error: "Malformed body." });

  const memoryType = parseMemoryType(body.memoryType);
  const groupId = parsePositiveInt(body.groupId);
  const memoryId = parsePositiveInt(body.memoryId);
  if (memoryType === null || groupId === null || memoryId === null) {
    return json(res, 400, { error: "Malformed memory reference." });
  }

  try {
    // Returns how many rows were stamped: the belief and everything it was later
    // refined into. Zero means there was nothing to withdraw — an unknown id, a
    // belief in another chat, or one already revoked.
    const revoked = await revokeMemory(deps.pool, { memoryType, groupId, memoryId });
    if (revoked === 0) return json(res, 404, { error: "not_found" });
    json(res, 200, { revoked });
  } catch {
    json(res, 500, { error: "Failed to revoke memory." });
  }
}
