/**
 * roster.ts — who is in a group, in the one shape @Aida's prompt wants.
 *
 * One place for the policy (limit, owner inclusion, label resolution) so the
 * live path, the sandbox verifier, and the doctor check cannot drift into asking
 * three different questions. That drift is not hypothetical here: ask-redteam
 * exercising a different prompt than production is exactly how three guardrail
 * bugs shipped (#67).
 *
 * Deliberately does NOT catch. Callers decide: the live path degrades to no
 * roster (answering without it beats not answering), while the sandbox and the
 * doctor check must fail loudly, or a broken roster would look like a passing run.
 */
import type pg from "pg";
import { listGroupParticipants } from "../db/repositories/participants.js";
import { resolveSenderName } from "../summarization/sender-name.js";

/**
 * How many members to name. Headroom, not a guess: measured on the live DB, the
 * widest group @Aida serves has 6 real-named participants. A truncated roster
 * silently reintroduces the non-member floor for the quietest member, so this is
 * set well clear of the real distribution rather than tuned to it.
 */
export const ROSTER_LIMIT = 25;

/**
 * The group's members, most active first, as display labels.
 *
 * `includeOwner` is on: the device owner is a member and the most-asked-about
 * person in the corpus, so omitting him routes every question about him to the
 * non-member floor — the exact bug the roster exists to fix.
 *
 * Names go through resolveSenderName so the roster lands in the SAME name-space
 * the transcript renders; a roster naming "Dana Cohen" while the transcript says
 * "דנה" would be worse than no roster at all.
 */
export async function buildGroupRoster(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<string[]> {
  const rows = await listGroupParticipants(client, groupId, ROSTER_LIMIT, { includeOwner: true });
  return rows.map((r) => resolveSenderName(r.name));
}
