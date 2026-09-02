import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  buildRepairPrompt,
  MAX_REPAIR_CONTENT,
  parseRepair,
  validateJudge,
  validateRepair,
} from "./memory-repair.js";

const cited = [
  { messageId: 57578, author: "Royi", text: "שכחתי שגרתי שם" },
  { messageId: 66568, author: "Royi", text: "אני בראשון עם אבק" },
];

describe("buildRepairPrompt", () => {
  it("shows the belief, its kind, and every cited message with its id and author", () => {
    const prompt = buildRepairPrompt({ memoryType: "semantic", content: "הוא גר ביפו" }, cited);
    expect(prompt).toContain("הוא גר ביפו");
    expect(prompt).toContain("kind: semantic");
    expect(prompt).toContain("[57578] Royi: שכחתי שגרתי שם");
    expect(prompt).toContain("[66568] Royi: אני בראשון עם אבק");
  });

  it("states the four rules ABOVE the belief they apply to", () => {
    const prompt = buildRepairPrompt({ memoryType: "semantic", content: "הוא גר ביפו" }, cited);
    // Position, not wording, is what has decided whether a rule binds on this
    // stack — so the ordering is asserted rather than left to the author. Each
    // marker is confirmed present FIRST: comparing two indexOf results without
    // that would let a reworded (i.e. vanished) marker pass vacuously whenever
    // it happened to compare as -1 < <some positive index>.
    expect(prompt).toContain("APPLY THESE LITERALLY");
    expect(prompt).toContain("THE BELIEF");
    expect(prompt.indexOf("APPLY THESE LITERALLY")).toBeLessThan(prompt.indexOf("THE BELIEF"));

    expect(prompt).toContain("Tense must match");
    expect(prompt).toContain("THE MESSAGES IT CITES");
    expect(prompt.indexOf("Tense must match")).toBeLessThan(
      prompt.indexOf("THE MESSAGES IT CITES"),
    );
  });

  it("collapses whitespace so a multi-line message cannot forge a new prompt line", () => {
    const prompt = buildRepairPrompt({ memoryType: "episodic", content: "x" }, [
      { messageId: 1, author: "A", text: "one\n[2] B: two" },
    ]);
    expect(prompt).toContain("[1] A: one [2] B: two");
    expect(prompt.split("\n").filter((l) => l.startsWith("[2] B:"))).toHaveLength(0);
  });
});

describe("buildJudgePrompt", () => {
  it("shows the belief, its kind, and every cited message with its id and author", () => {
    const prompt = buildJudgePrompt({ memoryType: "semantic", content: "הוא גר ביפו" }, cited);
    expect(prompt).toContain("הוא גר ביפו");
    expect(prompt).toContain("kind: semantic");
    expect(prompt).toContain("[57578] Royi: שכחתי שגרתי שם");
    expect(prompt).toContain("[66568] Royi: אני בראשון עם אבק");
  });

  it("states the support rules ABOVE the belief and messages they apply to", () => {
    const prompt = buildJudgePrompt({ memoryType: "semantic", content: "הוא גר ביפו" }, cited);
    // Same measured finding as the repair prompt: position, not wording, decides
    // whether a rule binds, so the ordering is asserted rather than trusted. Each
    // marker is confirmed present FIRST, so a reworded rule fails loudly instead
    // of the comparison passing vacuously on a stray -1.
    expect(prompt).toContain("IT IS SUPPORTED ONLY IF ALL OF THESE HOLD");
    expect(prompt).toContain("THE BELIEF");
    expect(prompt.indexOf("IT IS SUPPORTED ONLY IF ALL OF THESE HOLD")).toBeLessThan(
      prompt.indexOf("THE BELIEF"),
    );

    expect(prompt).toContain("The tense matches");
    expect(prompt).toContain("THE MESSAGES IT CITES");
    expect(prompt.indexOf("The tense matches")).toBeLessThan(
      prompt.indexOf("THE MESSAGES IT CITES"),
    );
  });

  it("collapses whitespace so a multi-line message cannot forge a new prompt line", () => {
    const prompt = buildJudgePrompt({ memoryType: "episodic", content: "x" }, [
      { messageId: 1, author: "A", text: "one\n[2] B: two" },
    ]);
    expect(prompt).toContain("[1] A: one [2] B: two");
    expect(prompt.split("\n").filter((l) => l.startsWith("[2] B:"))).toHaveLength(0);
  });

  it("asks only for a supported yes/no and a reason — never a rewrite", () => {
    const prompt = buildJudgePrompt({ memoryType: "semantic", content: "הוא גר ביפו" }, cited);
    expect(prompt).toContain('{"supported":true,"reason":"..."}');
    expect(prompt).toContain(
      '{"supported":false,"reason":"<which rule it breaks, in one short English sentence>"}',
    );
    // No rewrite is on the table: nothing here asks for an action or a content field.
    expect(prompt).not.toContain('"action"');
    expect(prompt).not.toContain('"content"');
  });
});

describe("parseRepair", () => {
  it("reads a bare object", () => {
    expect(parseRepair('{"action":"keep","content":"a","reason":"b"}')).toEqual({
      action: "keep",
      content: "a",
      reason: "b",
    });
  });

  it("reads an object a model wrapped in prose or a fence", () => {
    const reply = 'Here is my answer:\n```json\n{"action":"drop","content":"","reason":"r"}\n```';
    expect(parseRepair(reply)).toEqual({ action: "drop", content: "", reason: "r" });
  });

  it("returns null rather than throwing on a reply with no object in it", () => {
    expect(parseRepair("I think the belief is fine.")).toBeNull();
    expect(parseRepair("{not json}")).toBeNull();
    expect(parseRepair("")).toBeNull();
  });

  it("returns the LAST object when the model self-corrects with a second fenced JSON block", () => {
    // Measured: the local model regularly emits a fenced verdict, then "Wait,
    // ..." prose re-reading itself, then a SECOND fenced object — its actual
    // final answer. The old first-`{`-to-last-`}` slice spanned both objects
    // and never parsed at all.
    const reply = [
      "Let me check this.",
      "```json",
      '{"action":"drop","content":"","reason":"first guess, looks unsupported"}',
      "```",
      "Wait, re-reading the messages, rule 1 is actually satisfied.",
      "```json",
      '{"action":"keep","content":"x","reason":"satisfied on closer read"}',
      "```",
    ].join("\n");
    expect(parseRepair(reply)).toEqual({
      action: "keep",
      content: "x",
      reason: "satisfied on closer read",
    });
  });

  it("still parses a single object even when trailing prose contains a stray unbalanced '{'", () => {
    const reply = '{"action":"keep","content":"x","reason":"fine"} Wait, I mean { that seems off';
    expect(parseRepair(reply)).toEqual({ action: "keep", content: "x", reason: "fine" });
  });

  it("falls back to an earlier balanced object when the last one fails to parse", () => {
    const reply = '{"action":"keep","content":"x","reason":"ok"} then noise: {not json}';
    expect(parseRepair(reply)).toEqual({ action: "keep", content: "x", reason: "ok" });
  });

  it("returns null for unbalanced garbage with no complete object at all", () => {
    expect(parseRepair("{not json")).toBeNull();
    expect(parseRepair("{{{")).toBeNull();
  });

  it("is not fooled by an unmatched quote in the prose before the object", () => {
    // A brace-depth scan that starts tracking JSON strings before it has ever
    // entered an object would read this lone opening quote as "now inside a
    // string" and swallow the whole object that follows as unterminated
    // string content — the exact class of refusal this function exists to
    // eliminate, just moved to a different trigger (local models narrate with
    // unbalanced quotes routinely: `it says "lives in Jaffa" but...`).
    const reply = 'He said "it is fine. {"action":"keep","content":"x","reason":"r"}';
    expect(parseRepair(reply)).toEqual({ action: "keep", content: "x", reason: "r" });
  });

  it("also reads a judge-shaped reply, wrapped in prose, that validateJudge accepts", () => {
    // The run harness feeds the judge's reply through this same function — the
    // pairing has to hold for judge shapes, not only repair shapes.
    const reply =
      'Sure, here is my answer:\n```json\n{"supported":false,"reason":"tense mismatch"}\n```';
    const { ok } = validateJudge(parseRepair(reply));
    expect(ok).toEqual({ supported: false, reason: "tense mismatch" });
  });
});

describe("validateJudge", () => {
  it("accepts a supported verdict", () => {
    const { ok } = validateJudge({ supported: true, reason: "all four hold" });
    expect(ok).toEqual({ supported: true, reason: "all four hold" });
  });

  it("accepts an unsupported verdict", () => {
    const { ok } = validateJudge({ supported: false, reason: "tense mismatch" });
    expect(ok).toEqual({ supported: false, reason: "tense mismatch" });
  });

  it("refuses a reply that is not an object", () => {
    expect(validateJudge(null).reason).toBe("not-an-object");
    expect(validateJudge([{ supported: true }]).reason).toBe("not-an-object");
    expect(validateJudge("true").reason).toBe("not-an-object");
  });

  it("refuses a missing or non-boolean supported, never coercing one", () => {
    // A string "false" is not a false — coercing it would read a refusal as an
    // approval, the direction that silently keeps a wrong belief.
    expect(validateJudge({ reason: "r" })).toEqual({ ok: null, reason: "bad-supported" });
    expect(validateJudge({ supported: "false", reason: "r" })).toEqual({
      ok: null,
      reason: "bad-supported",
    });
    expect(validateJudge({ supported: "true", reason: "r" })).toEqual({
      ok: null,
      reason: "bad-supported",
    });
  });

  it("refuses a missing, empty, or whitespace-only reason", () => {
    expect(validateJudge({ supported: true })).toEqual({ ok: null, reason: "no-reason" });
    expect(validateJudge({ supported: true, reason: "" })).toEqual({
      ok: null,
      reason: "no-reason",
    });
    expect(validateJudge({ supported: true, reason: "   " })).toEqual({
      ok: null,
      reason: "no-reason",
    });
  });
});

describe("validateRepair", () => {
  const original = "הוא גר ביפו";

  it("accepts a rewrite and returns the corrected text", () => {
    const { ok } = validateRepair(
      { action: "rewrite", content: "הוא גר ביפו בעבר", reason: "past tense" },
      original,
    );
    expect(ok).toEqual({ action: "rewrite", content: "הוא גר ביפו בעבר", reason: "past tense" });
  });

  it("accepts a drop, which carries no content", () => {
    const { ok } = validateRepair({ action: "drop", content: "", reason: "unsupported" }, original);
    expect(ok).toEqual({ action: "drop", content: "", reason: "unsupported" });
  });

  it("gives a keep the ORIGINAL text, not whatever the model echoed", () => {
    // A keep whose content drifted by a word is a rewrite that did not declare
    // itself, and storing the echo would silently change the belief.
    const { ok } = validateRepair(
      { action: "keep", content: "הוא גר ביפו!!", reason: "supported" },
      original,
    );
    expect(ok?.action).toBe("keep");
    expect(ok?.content).toBe(original);
  });

  it("turns a rewrite identical to the original into a keep", () => {
    // Otherwise the supersede chain fills with no-ops and the one real
    // correction gets harder to find.
    const { ok } = validateRepair(
      { action: "rewrite", content: `  ${original}  `, reason: "already right" },
      original,
    );
    expect(ok?.action).toBe("keep");
  });

  it("refuses an action nobody asked for", () => {
    expect(validateRepair({ action: "delete", content: "x", reason: "r" }, original)).toEqual({
      ok: null,
      reason: "bad-action",
    });
    expect(validateRepair({ content: "x", reason: "r" }, original)).toEqual({
      ok: null,
      reason: "bad-action",
    });
  });

  it("refuses any verdict without a reason, a drop most of all", () => {
    // A drop with no reason is a silent deletion — the failure this pass is most
    // likely to introduce and the hardest to notice later.
    expect(validateRepair({ action: "drop", content: "", reason: "  " }, original)).toEqual({
      ok: null,
      reason: "no-reason",
    });
    expect(validateRepair({ action: "rewrite", content: "x" }, original)).toEqual({
      ok: null,
      reason: "no-reason",
    });
  });

  it("refuses a rewrite with nothing in it", () => {
    expect(validateRepair({ action: "rewrite", content: "   ", reason: "r" }, original)).toEqual({
      ok: null,
      reason: "empty-content",
    });
  });

  it("refuses a rewrite longer than storage will take", () => {
    // Bounded at the same length validateCandidate uses: a repair that cleared
    // this pass and then failed to store would be a correction the operator
    // watched happen and never got.
    const { ok, reason } = validateRepair(
      { action: "rewrite", content: "א".repeat(MAX_REPAIR_CONTENT + 1), reason: "r" },
      original,
    );
    expect(ok).toBeNull();
    expect(reason).toBe("too-long");
  });

  it("refuses a reply that is not an object", () => {
    expect(validateRepair(null, original).reason).toBe("not-an-object");
    expect(validateRepair([{ action: "keep" }], original).reason).toBe("not-an-object");
    expect(validateRepair("keep", original).reason).toBe("not-an-object");
  });
});
