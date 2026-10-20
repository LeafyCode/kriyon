# ADR 0001 — Three-layer agent governance

**Date:** 2026-06-16
**Status:** Accepted, updated by ADR 0044 (the rulebook, agents and guard hook for a public repo)

## Context

Kriyon is built largely by AI agents. Long, prose-heavy instruction files get skimmed and ignored;
rules that are only written down (not enforced) drift. We want agents to follow project conventions
reliably without paying a large always-on context cost, and without trusting prose to hold the line.

## Decision

Adopt the three-layer model (pattern from an earlier LeafyCode repo, adapted to this stack):

1. **Short, always-on rules** — root `AGENTS.md` is terse: one line per rule, each pointing to a
   `→ skill:` or doc for depth. Nested `AGENTS.md` in `src-tauri/` and `src/` add the local "one
   right way". `CLAUDE.md` is just `@AGENTS.md`. A `CONTEXT.md` glossary fixes the domain language.
2. **On-demand depth** — detailed workflow and clean-code guidance lives in
   `.claude/skills/engineering-workflow/`, loaded only when relevant, so it never bloats context.
3. **Automated enforcement** — rules that *can* be mechanical are owned by tools, not prose:
   Biome/Ultracite (format + JS/TS lint), clippy (Rust lint), lefthook + commitlint (branch
   protection, commit format), a `PreToolUse` Claude hook (`guard-git.mjs`, blocks `--no-verify`
   and `git push --force`), and CI re-running everything. `pnpm check` is the single green gate.

## Consequences

- Agents get a small, scannable rule set plus enforcement that catches violations regardless of
  whether the prose was read.
- "Architecture as lint": the Rust-core-owns-IO and thin-UI boundaries are reinforced by Biome
  overrides (e.g. no `console` in `src/**`) and the nested `AGENTS.md` files.
- New rules should be added as enforcement first, prose second. Prose without an enforcer is a
  known weak point.
