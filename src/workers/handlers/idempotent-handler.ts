/**
 * makeIdempotentHandler — the redelivery-idempotency guard shared by the
 * `transcribe.voicenote` and `analyze.image`/`analyze.video` job handlers.
 *
 * The worker cores (transcribeNoteCore / analyzeMediaOne) deliberately do NOT
 * self-check for existing results — that check is the handler's responsibility
 * (so batch callers that already select only pending work don't pay for a
 * redundant per-item lookup). This wrapper is where that policy lives: if
 * `isDone(...args)` is already true, skip; otherwise run `work(...args)` (which
 * throws on failure so the bus retries).
 *
 * Variadic over the handler's arguments so it fits both shapes: the transcribe
 * handler takes just `(job)`, the analyze handler takes `(job, type)`. `isDone`
 * and `work` receive the same arguments.
 */
export function makeIdempotentHandler<Args extends unknown[]>(deps: {
  isDone: (...args: Args) => Promise<boolean>;
  work: (...args: Args) => Promise<void>;
}): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    if (await deps.isDone(...args)) {
      return;
    }
    await deps.work(...args);
  };
}
