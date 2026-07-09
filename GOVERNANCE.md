# GOVERNANCE.md

The **behavior contract** for agent sessions on Sumbox. `CLAUDE.md` describes
*how the codebase works*; this file describes *how the agent must behave*. It is
loaded every session via `@GOVERNANCE.md` in `CLAUDE.md`.

Built on the **Karpathy Method**: three immutable layers that exist to kill
*context-drift* — the failure mode where an agent optimizes the immediate prompt
while losing the macro goal, the real definition of "done", and the workshop's
hard boundaries. Each layer is a fixed reference to check work against, not an
in-the-moment guess.

> **Precedence:** the user's explicit instructions always win over this file.
> This file wins over default behavior. When a rule here conflicts with a direct
> request, follow the request and say so.

## ── Layer 1 · The Spec (north star & cadence) ──────────────────

**North star.** Sumbox is a **single-user, zero-config local tool** — a fun,
personal WhatsApp summarizer, not a hosted product. There is no login, no
accounts, no server to operate for anyone but the person running it on their
own machine. Every change is checked against this: if a change adds
account/server/multi-user surface, it is drifting — stop and reconsider.

**Cadence — spec before code.** No implementation begins without a signed-off
spec. This is non-negotiable regardless of how "simple" the task looks; unexamined
assumptions on simple tasks cause the most wasted work.

**Spec size — default small, escalate by risk.**

- **Default:** one spec == one shippable PR (a vertical slice an agent can fully
  spec, verify, and hand off cleanly).
- **Escalate** to an epic + gated PR stack *only* for cross-cutting / high-risk
  work: migrations or any change spanning multiple surfaces.

Each spec → plan → implementation runs its own cycle. If a request bundles
several independent subsystems, **decompose first**, then spec the first piece.

## ── Layer 2 · The Verifier (definition of done) ────────────────

"Good code" is not a feeling. **Done** is proven by external signals, every time —
no blind guessing.

**Every change must clear all three:**

1. **Quoted CI evidence.** Run the gate and paste the *real* output — never
   "should pass." The gate is:
   ```
   npm run check      # biome check src   (autofix: npm run check --write / npm run format)
   npm run typecheck  # tsc --noEmit
   npm run build      # tsc + copy web assets
   npm test           # vitest run src    (needs Docker for Testcontainers)
   ```
   CI collapses these into the single required `ci-ok` check.
2. **Observed behavior.** Verify the change does what it claims by actually
   running it — not by reasoning about the code.
3. **Critic pass.** Run an adversarial read over the diff (`code-reviewer`,
   `silent-failure-hunter`, `type-design-analyzer`, or a second-model pass) and
   **resolve** the findings before handoff.

**UI work — additional visual gates (all hard):**

- **Linear-grade restraint:** scannable, modern, minimalist — one sage accent, no
  decorative clutter.
- **RTL/Hebrew correct:** mirroring, text alignment, and numerals render right.
- **Token-true:** reuse existing design tokens/components; no ad-hoc styles or new
  patterns without sign-off.
- **Screenshot-verified:** confirmed from an actual *rendered screenshot* (the
  run/preview tooling), never eyeballed from code.

**The human-verify gate stays the human's.** Hand off a PR that is easy to run and
confirm; never assume that gate or claim it on the user's behalf.

## ── Layer 3 · The Environment (map & hard boundaries) ──────────

### Workspace map

| Path | Purpose |
|---|---|
| `src/collector/` | WhatsApp link + ingest (Baileys session) |
| `src/db/` · `…/repositories/` · `…/migrations/` | Postgres source of truth · repository pattern · `node-pg-migrate` (one concern, up+down) |
| `src/jobs/` · `src/workers/` · `…/handlers/` | RabbitMQ bus · workers · per-job handler logic |
| `src/serve/` · `src/web/` (`…/public/`) | HTTP server · RTL mobile web app + static assets |
| `src/summarization/` | Summary/digest generation pipeline |
| `src/media/` · `src/transcription/` · `src/vision/` | Media pipeline · faster-whisper STT · local vision |
| `src/ops/` · `src/doctor/` | Operational tooling · diagnostics |
| `src/test/` | Shared test harness (`globalSetup`, isolated DB clones) |

### ✅ Always Do — autopilot, no need to ask

- Run `biome check --write` / `npm run format` before committing.
- Run the full preflight gate (typecheck · build · test) before opening/updating a PR.
- Build features as an **atomic, bottom-up commit stack** with conventional
  `type(scope):` messages (reuse the established scope vocabulary).
- Create migrations with `npm run migrate:create` (timestamp-prefixed, **never**
  hand-numbered), one concern each, with both `up` and `down`.
- Colocate `*.test.ts` next to its source; inject probes rather than mocking globals.

### ⚠️ Ask First — stop and check, even with an approved spec

- Merge a PR · force-push.
- Destructive DB operations / data deletion.
- Migrations that alter schema beyond the signed spec.
- **Any new outbound network call** to an external service (telemetry, metadata,
  error reporting included) — the absolute ban on *message content* leaving the
  device is non-negotiable and lives under Never Do; everything else that talks to
  the network gets a check first.
- Add a new **production** dependency.
- Add a login/account/server surface.
- Take on **any scope not in the signed spec**.

### ⛔ Never Do — immutable

- **Leak message content off-device.** All inference (LLM, STT, vision) is local;
  message content never leaves the device. Hard constraint.
- **Leave unfinished work:** no placeholder/stub code, no dead `TODO`s, no
  half-built surfaces presented as done.
- **Ship cluttered UI** — no decorative noise, no orphaned controls.
- **Claim "done" without the evidence + critic pass** from Layer 2.
- **Broad process kills** (`pkill -f` / pattern kills against background servers) —
  always target the exact PID.
- **Break commit/migration discipline** — never squash a feature into one commit;
  never hand-number a migration.
- **Add a needless new prod dependency** to do what the existing stack
  (`pg`, `amqplib`, Baileys, Ollama, Biome, Vitest) already does.
