# AGENTS.md

**[`CLAUDE.md`](./CLAUDE.md) is the single source of truth for agent grounding on
Sumbox.** Read it first — stack, ship lifecycle, commit and migration discipline,
test conventions, and local dev all live there.

Then read [`GOVERNANCE.md`](./GOVERNANCE.md), the behavior contract: the three
immutable layers (Spec · Verifier · Environment) that govern how agents work here.

This file exists because `AGENTS.md` is the cross-tool convention. It used to be a
hand-synced copy of `CLAUDE.md` and the two had already drifted, so it is now a
pointer instead of a duplicate.

## The one tool-specific note

Branch prefixes for agent work follow the tool: `claude/…` for Claude Code,
`codex/…` for Codex. Everything else — `feat/` `fix/` `docs/` `chore/` — is shared
and documented in `CLAUDE.md`.
