import type { CitedAnswer } from "./citations.js";

type Run = (i: { groupId: number; question: string }) => Promise<CitedAnswer>;

/** Route @Aida's answer: agentic (with fallback) when the flag is on, else the
 *  proven single-shot. The agentic path can never make the feature worse — any
 *  error falls back to single-shot. */
export async function answerAida(
  deps: {
    agentic: boolean;
    runAgentic: Run;
    runSingleShot: Run;
    log?: { warn: (o: unknown, m?: string) => void };
  },
  input: { groupId: number; question: string },
): Promise<CitedAnswer> {
  if (!deps.agentic) return deps.runSingleShot(input);
  try {
    return await deps.runAgentic(input);
  } catch (err) {
    deps.log?.warn({ err }, "@Aida agentic path failed; falling back to single-shot");
    return deps.runSingleShot(input);
  }
}
