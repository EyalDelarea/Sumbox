import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemory, type MemoryWriteResult } from "../db/repositories/aida-memory.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import { createTestDatabase } from "../test/db.js";
import { MAX_CITED_MESSAGE_CHARS, truncateCitedText } from "./memory-repair.js";
import {
  citedMessagesFor,
  REPAIR_NOTE_PREFIX,
  type RepairModel,
  repairGroupMemories,
} from "./memory-repair-run.js";

/**
 * Orchestration tests for `repairGroupMemories` — the impure run loop, not the
 * pure prompt-building/parsing in `memory-repair.test.ts`.
 *
 * The `RepairModel` seam is the whole point: every test injects a scripted probe
 * that records every prompt it was asked and answers by matching markers unique
 * to the judge prompt ("IT IS SUPPORTED ONLY IF") vs. the repair prompt ("APPLY
 * THESE LITERALLY"), plus a substring of the belief content under test, so
 * multiple beliefs in one run can be scripted and inspected independently
 * without depending on call order.
 *
 * The one property that matters most is BLINDNESS (see the last describe
 * block): a belief must be re-read against nothing but its own content and its
 * own cited messages. Everything else this module could theoretically leak
 * in — the group's name, another belief on file, a subject's identity — must
 * not reach the prompt.
 */
describe("repairGroupMemories", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function newGroup(name: string): Promise<{ id: number; name: string }> {
    const fullName = `${name}-${randomUUID().slice(0, 8)}`;
    const id = await upsertGroup(pool, { name: fullName, source: "live" });
    return { id, name: fullName };
  }

  async function newParticipant(name: string): Promise<number> {
    return await upsertParticipant(pool, `${name}-${randomUUID().slice(0, 8)}`);
  }

  async function newMessage(
    groupId: number,
    opts: { text?: string; participantId?: number | null; sentAt?: Date } = {},
  ): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages
         (group_id, source, message_type, text_content, participant_id, sent_at, dedupe_key)
       VALUES ($1, 'live', 'text', $2, $3, COALESCE($4, now()), $5)
       RETURNING id`,
      [
        groupId,
        opts.text ?? "hello",
        opts.participantId ?? null,
        opts.sentAt ?? null,
        `dk-${randomUUID()}`,
      ],
    );
    return Number(rows[0]?.id);
  }

  /** `createMemory`, with "it actually wrote something" asserted rather than assumed. */
  async function write(draft: Parameters<typeof createMemory>[1]): Promise<MemoryWriteResult> {
    const result = await createMemory(pool, draft);
    expect(result, "expected this write to land").not.toBeNull();
    return result as MemoryWriteResult;
  }

  async function episodicRow(memoryId: number): Promise<{
    superseded_by_id: string | null;
    correction_note: string | null;
    revoked_at: Date | null;
  }> {
    const { rows } = await pool.query<{
      superseded_by_id: string | null;
      correction_note: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT superseded_by_id, correction_note, revoked_at FROM aida_episodic_memories WHERE id = $1`,
      [memoryId],
    );
    const row = rows[0];
    if (!row) throw new Error(`episodicRow: no row ${memoryId}`);
    return row;
  }

  async function flagRow(memoryId: number): Promise<{ reason: string }[]> {
    const { rows } = await pool.query<{ reason: string }>(
      `SELECT reason FROM aida_memory_flags WHERE memory_type = 'episodic' AND memory_id = $1`,
      [memoryId],
    );
    return rows;
  }

  async function episodicCount(groupId: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM aida_episodic_memories WHERE group_id = $1`,
      [groupId],
    );
    return Number(rows[0]?.n);
  }

  // ── The scripted model probe ─────────────────────────────────────────────

  const JUDGE_MARKER = "IT IS SUPPORTED ONLY IF";
  const REPAIR_MARKER = "APPLY THESE LITERALLY";

  type ScriptRule = { when: string[] } & ({ reply: string } | { throw: string });

  /**
   * A `RepairModel` that answers by matching markers in the prompt, not by call
   * order — because `listLiveMemories` ranks by evidence/recency, not insertion
   * order, so a multi-belief run cannot be scripted as a fixed queue.
   */
  function scriptedModel(script: ScriptRule[]): RepairModel & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      async ask(prompt: string): Promise<string> {
        prompts.push(prompt);
        const rule = script.find((r) => r.when.every((s) => prompt.includes(s)));
        if (!rule) {
          throw new Error(`scriptedModel: no rule matched this prompt:\n${prompt.slice(0, 400)}`);
        }
        if ("throw" in rule) throw new Error(rule.throw);
        return rule.reply;
      },
    };
  }

  const judgeSupported = (reason: string) => JSON.stringify({ supported: true, reason });
  const judgeUnsupported = (reason: string) => JSON.stringify({ supported: false, reason });
  const repairRewrite = (content: string, reason: string) =>
    JSON.stringify({ action: "rewrite", content, reason });
  const repairDrop = (reason: string) => JSON.stringify({ action: "drop", content: "", reason });
  const repairKeep = (reason: string) => JSON.stringify({ action: "keep", reason });

  // ── 1. A supported belief is kept after the judge alone ──────────────────

  it("keeps a supported belief after the judge step, and never builds the repair prompt", async () => {
    const g = await newGroup("judge-keeps");
    const content = `content-${randomUUID()}`;
    const m = await newMessage(g.id, { text: "the evidence for it" });
    const belief = await write({
      memoryType: "episodic",
      groupId: g.id,
      content,
      evidence: [{ messageId: m, stance: "supports" }],
    });

    const model = scriptedModel([
      { when: [content, JUDGE_MARKER], reply: judgeSupported("fully carried by the message") },
    ]);

    const run = await repairGroupMemories(pool, { groupId: g.id, model, write: true });

    const record = run.records.find((r) => r.memoryId === belief.id);
    expect(record?.outcome).toMatchObject({ kind: "kept", step: "judge" });
    expect(run.tally.kept).toBe(1);

    // The repair prompt was never built: exactly one call for this belief, and it
    // was the judge prompt.
    const ownPrompts = model.prompts.filter((p) => p.includes(content));
    expect(ownPrompts).toHaveLength(1);
    expect(ownPrompts[0]).toContain(JUDGE_MARKER);
    expect(ownPrompts[0]).not.toContain(REPAIR_MARKER);
  });

  // ── 1b. Judge and repair DISAGREE: unsupported, then kept anyway ──────────

  it("keeps a belief with step:'repair' when the judge calls it unsupported but the repair step answers keep", async () => {
    // The exact disagreement `RepairOutcome.step` exists to record (see the
    // header comment on `buildJudgePrompt`): the cheap yes/no check refuses a
    // belief, the closer-reading repair prompt is shown the same evidence and
    // answers keep anyway. Before the split this landed as an indistinguishable
    // `{kind:"kept"}` — step:'judge' is the only case exercised without this.
    const g = await newGroup("judge-repair-disagree");
    const content = `content-${randomUUID()}`;
    const m = await newMessage(g.id, { text: "evidence that actually supports it" });
    const belief = await write({
      memoryType: "episodic",
      groupId: g.id,
      content,
      evidence: [{ messageId: m, stance: "supports" }],
    });

    const model = scriptedModel([
      { when: [content, JUDGE_MARKER], reply: judgeUnsupported("looked unsupported at first") },
      { when: [content, REPAIR_MARKER], reply: repairKeep("actually fine on closer read") },
    ]);

    const run = await repairGroupMemories(pool, { groupId: g.id, model, write: true });
    const record = run.records.find((r) => r.memoryId === belief.id);
    expect(record?.outcome).toMatchObject({ kind: "kept", step: "repair" });
    expect(run.tally.kept).toBe(1);

    // A repair-step keep is still a keep: nothing is written.
    const row = await episodicRow(belief.id);
    expect(row.superseded_by_id).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(await episodicCount(g.id)).toBe(1);
  });

  // ── 2. Unsupported + rewrite → SUPERSEDE via correctMemory ───────────────

  describe("unsupported, repair rewrites", () => {
    it("supersedes the belief when write=true, with a correction_note starting 'repair: '", async () => {
      const g = await newGroup("repair-rewrite-write");
      const content = `content-${randomUUID()}`;
      const corrected = `corrected-${randomUUID()}`;
      const m = await newMessage(g.id, { text: "only partial support" });
      const belief = await write({
        memoryType: "episodic",
        groupId: g.id,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });

      const model = scriptedModel([
        { when: [content, JUDGE_MARKER], reply: judgeUnsupported("tense does not match") },
        { when: [content, REPAIR_MARKER], reply: repairRewrite(corrected, "fixed the tense") },
      ]);

      const run = await repairGroupMemories(pool, { groupId: g.id, model, write: true });
      const record = run.records.find((r) => r.memoryId === belief.id);
      expect(record?.outcome.kind).toBe("rewritten");
      expect(record?.outcome).toMatchObject({ written: true });
      const newMemoryId =
        record?.outcome.kind === "rewritten" ? record.outcome.newMemoryId : undefined;
      expect(newMemoryId).toBeDefined();

      const old = await episodicRow(belief.id);
      expect(Number(old.superseded_by_id)).toBe(newMemoryId);
      // Old row is never rewritten in place.
      const newRow = await episodicRow(newMemoryId as number);
      expect(newRow.correction_note).toMatch(new RegExp(`^${REPAIR_NOTE_PREFIX}\\s`));
      expect(newRow.correction_note).toContain("fixed the tense");
      expect(run.tally.rewritten).toBe(1);
    });

    it("changes nothing in the database when write=false, and reports would_rewrite", async () => {
      const g = await newGroup("repair-rewrite-dry");
      const content = `content-${randomUUID()}`;
      const corrected = `corrected-${randomUUID()}`;
      const m = await newMessage(g.id, { text: "only partial support" });
      const belief = await write({
        memoryType: "episodic",
        groupId: g.id,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });

      const model = scriptedModel([
        { when: [content, JUDGE_MARKER], reply: judgeUnsupported("tense does not match") },
        { when: [content, REPAIR_MARKER], reply: repairRewrite(corrected, "fixed the tense") },
      ]);

      const run = await repairGroupMemories(pool, { groupId: g.id, model, write: false });
      const record = run.records.find((r) => r.memoryId === belief.id);
      expect(record?.outcome).toMatchObject({ kind: "rewritten", written: false });
      expect(run.tally.would_rewrite).toBe(1);

      const row = await episodicRow(belief.id);
      expect(row.superseded_by_id).toBeNull();
      expect(row.correction_note).toBeNull();
      expect(await episodicCount(g.id)).toBe(1);
    });
  });

  // ── 3. Unsupported + drop → FLAG, never revoke ────────────────────────────

  describe("unsupported, repair drops", () => {
    it("writes a flag row when write=true, and never revokes the belief", async () => {
      const g = await newGroup("repair-drop-write");
      const content = `content-${randomUUID()}`;
      const m = await newMessage(g.id, { text: "nothing supports this" });
      const belief = await write({
        memoryType: "episodic",
        groupId: g.id,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });

      const model = scriptedModel([
        { when: [content, JUDGE_MARKER], reply: judgeUnsupported("invented the whole place") },
        { when: [content, REPAIR_MARKER], reply: repairDrop("nothing survives rules 1-4") },
      ]);

      const run = await repairGroupMemories(pool, { groupId: g.id, model, write: true });
      const record = run.records.find((r) => r.memoryId === belief.id);
      expect(record?.outcome).toMatchObject({ kind: "flagged", written: true });
      expect(run.tally.flagged).toBe(1);

      const flags = await flagRow(belief.id);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.reason).toBe("nothing survives rules 1-4");

      // NEVER REVOKES. The belief must still be live.
      const row = await episodicRow(belief.id);
      expect(row.revoked_at).toBeNull();
    });

    it("writes no flag when write=false, and reports would_flag", async () => {
      const g = await newGroup("repair-drop-dry");
      const content = `content-${randomUUID()}`;
      const m = await newMessage(g.id, { text: "nothing supports this" });
      const belief = await write({
        memoryType: "episodic",
        groupId: g.id,
        content,
        evidence: [{ messageId: m, stance: "supports" }],
      });

      const model = scriptedModel([
        { when: [content, JUDGE_MARKER], reply: judgeUnsupported("invented the whole place") },
        { when: [content, REPAIR_MARKER], reply: repairDrop("nothing survives rules 1-4") },
      ]);

      const run = await repairGroupMemories(pool, { groupId: g.id, model, write: false });
      const record = run.records.find((r) => r.memoryId === belief.id);
      expect(record?.outcome).toMatchObject({ kind: "flagged", written: false });
      expect(run.tally.would_flag).toBe(1);

      expect(await flagRow(belief.id)).toHaveLength(0);
      const row = await episodicRow(belief.id);
      expect(row.revoked_at).toBeNull();
    });
  });

  // ── 4. No evidence left → no_evidence, no model call ──────────────────────

  it("reports no_evidence and never calls the model once every cited message is deleted", async () => {
    const g = await newGroup("no-evidence");
    const content = `content-${randomUUID()}`;
    const m = await newMessage(g.id, { text: "will be deleted" });
    const belief = await write({
      memoryType: "episodic",
      groupId: g.id,
      content,
      evidence: [{ messageId: m, stance: "supports" }],
    });
    await pool.query(`DELETE FROM messages WHERE id = $1`, [m]);

    const model = scriptedModel([]); // any call at all is a bug for this belief

    const run = await repairGroupMemories(pool, { groupId: g.id, model, write: true });
    const record = run.records.find((r) => r.memoryId === belief.id);
    expect(record?.outcome.kind).toBe("no_evidence");
    expect(run.tally.no_evidence).toBe(1);
    expect(model.prompts).toHaveLength(0);
  });

  // ── 5. One belief failing does not abort the run ──────────────────────────

  it("counts a model failure on one belief without losing the others", async () => {
    const g = await newGroup("partial-failure");
    const okContent = `ok-content-${randomUUID()}`;
    const badContent = `bad-content-${randomUUID()}`;
    const mOk = await newMessage(g.id, { text: "solid evidence" });
    const mBad = await newMessage(g.id, { text: "evidence for the one that fails" });

    const okBelief = await write({
      memoryType: "episodic",
      groupId: g.id,
      content: okContent,
      evidence: [{ messageId: mOk, stance: "supports" }],
    });
    const badBelief = await write({
      memoryType: "episodic",
      groupId: g.id,
      content: badContent,
      evidence: [{ messageId: mBad, stance: "supports" }],
    });

    const model = scriptedModel([
      { when: [okContent, JUDGE_MARKER], reply: judgeSupported("fine") },
      { when: [badContent, JUDGE_MARKER], throw: "the model timed out" },
    ]);

    const run = await repairGroupMemories(pool, { groupId: g.id, model, write: true });
    expect(run.records).toHaveLength(2);

    const okRecord = run.records.find((r) => r.memoryId === okBelief.id);
    const badRecord = run.records.find((r) => r.memoryId === badBelief.id);
    expect(okRecord?.outcome).toMatchObject({ kind: "kept", step: "judge" });
    expect(badRecord?.outcome).toMatchObject({ kind: "failed" });
    expect(badRecord?.outcome.kind === "failed" && badRecord.outcome.error).toContain(
      "the model timed out",
    );
    expect(run.tally.kept).toBe(1);
    expect(run.tally.failed).toBe(1);
  });

  // ── citedMessagesFor: the record must show no more than the prompt did ────

  describe("citedMessagesFor", () => {
    it("truncates a long cited message to the same bound renderCited applies, so the record matches the prompt", async () => {
      // Confirmed finding: renderCited (the prompt side) truncated each cited
      // message to MAX_CITED_MESSAGE_CHARS, but citedMessagesFor threaded the
      // FULL text into the RepairRecord — the human-evaluated artifact showed
      // more than the model ever read. truncateCitedText is the one shared
      // transform now applied on both sides.
      const g = await newGroup("cited-truncation");
      const longText = `${"a".repeat(MAX_CITED_MESSAGE_CHARS + 200)} trailing words after the cut`;
      expect(longText.length).toBeGreaterThan(MAX_CITED_MESSAGE_CHARS);
      const author = await newParticipant("LongAuthor");
      const m = await newMessage(g.id, { text: longText, participantId: author });
      const belief = await write({
        memoryType: "episodic",
        groupId: g.id,
        content: `content-${randomUUID()}`,
        evidence: [{ messageId: m, stance: "supports" }],
      });

      const cited = await citedMessagesFor(pool, {
        memoryType: "episodic",
        memoryId: belief.id,
      });

      expect(cited).toHaveLength(1);
      // Exactly the transform the prompt-building side applies — not merely
      // "some" truncation, so the record and the prompt can never drift apart.
      expect(cited[0]?.text).toBe(truncateCitedText(longText));
      expect(cited[0]?.text.length).toBeLessThanOrEqual(MAX_CITED_MESSAGE_CHARS);
    });
  });

  // ── 6. BLINDNESS — the property that matters most ─────────────────────────

  describe("blindness", () => {
    it("shows the model only the belief's own content and its own cited messages", async () => {
      const g = await newGroup("blind-groupname-marker");
      const underTestContent = `under-test-belief-${randomUUID()}`;
      const underTestEvidence = `under-test-evidence-${randomUUID()}`;
      const unrelatedContent = `unrelated-belief-${randomUUID()}`;
      const subjectName = `SubjectIdentity-${randomUUID()}`;

      // The belief under test, and the one message it cites.
      const testAuthor = await newParticipant("SomeAuthor");
      const mUnderTest = await newMessage(g.id, {
        text: underTestEvidence,
        participantId: testAuthor,
      });
      const underTest = await write({
        memoryType: "episodic",
        groupId: g.id,
        content: underTestContent,
        evidence: [{ messageId: mUnderTest, stance: "supports" }],
      });

      // A second, unrelated LIVE belief in the same group, about a named subject —
      // none of this must ever reach the prompt built for the belief above.
      const subjectParticipant = await newParticipant(subjectName);
      const mUnrelated = await newMessage(g.id, {
        text: "some other conversation entirely",
        participantId: subjectParticipant,
      });
      await write({
        memoryType: "episodic",
        groupId: g.id,
        content: unrelatedContent,
        evidence: [{ messageId: mUnrelated, stance: "supports" }],
      });

      const model = scriptedModel([
        { when: [underTestContent, JUDGE_MARKER], reply: judgeSupported("fine") },
        { when: [unrelatedContent, JUDGE_MARKER], reply: judgeSupported("also fine") },
      ]);

      await repairGroupMemories(pool, { groupId: g.id, model, write: false });

      const ownPrompts = model.prompts.filter((p) => p.includes(underTestContent));
      expect(ownPrompts.length).toBeGreaterThan(0);

      for (const prompt of ownPrompts) {
        // Sanity: the mechanism actually captured this belief's own evidence text —
        // otherwise an assertion that it's "absent" elsewhere would be vacuous.
        expect(prompt).toContain(underTestEvidence);

        expect(prompt).not.toContain(g.name);
        expect(prompt).not.toContain(unrelatedContent);
        expect(prompt).not.toContain(subjectName);
      }
      // And the reverse never happens either — the under-test belief must not leak
      // into the unrelated belief's prompt.
      const otherPrompts = model.prompts.filter((p) => p.includes(unrelatedContent));
      for (const prompt of otherPrompts) {
        expect(prompt).not.toContain(underTestContent);
        expect(prompt).not.toContain(underTestEvidence);
      }
      void underTest; // referenced only to keep the fixture write meaningful to readers
    });
  });
});
