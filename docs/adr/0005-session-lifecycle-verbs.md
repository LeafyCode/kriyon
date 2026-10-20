# ADR 0005 — Session-lifecycle verbs: launch-argument handoff, soft archive

**Date:** 2026-07-02
**Status:** Accepted

## Context

This arc added the [Session lifecycle] verbs around a Session: spawning a
[Follow-up session] (optionally in a fresh [Worktree]), and archiving a
Session once its work is done. Two decisions in it are novel enough to record.

## Decision 1: handoff seeding via a launch argument, not keystroke injection

A follow-up session needs a first prompt — Kriyon's natural successor to
Claude Code's own `/handoff` — built from the predecessor's transcript and
activity (`buildHandoffPrompt`). The obvious-looking approach, typing that
text into the newly-launched terminal, is **keystroke injection into a
running TUI**, which `AGENTS.md`'s "interactive prompts are TUI-only" rule
forbids: Kriyon does not scrape or drive `claude`'s interactive surface.

Instead, the Rust core writes the prompt to a **path-contained** file,
`~/.claude/kriyon/run/<id>.prompt` (`seed_prompt` in
`src-tauri/src/commands.rs`), where `<id>` is validated before it is
interpolated into the path (`seed_prompt_path` rejects `../evil` and `a/b`).
The session is then launched as `claude "$(cat <file>)"`. This was verified
against Claude Code's CLI: `claude "<prompt>"` starts the normal interactive
session with that prompt as the opening turn — only `-p`/`--print` is
headless — so no user text is ever shell-escaped by Kriyon, and the prompt
reaches Claude the same way a human's first line would.

## Decision 2: soft archive that preserves the transcript and worktree

Archiving a Session must not destroy the record a user might come back to.
Archiving sets a nullable `archivedAt` timestamp on the session row
(`sessions.ts`, `persistence.ts`) — it never deletes the row or touches the
Claude transcript on disk, so Past-session discovery (search, resume) keeps
working after archive.

Symmetrically, archiving never force-removes the session's worktree.
Worktree removal is a **separate, explicit opt-in**, offered only after a
clean merge, and implemented as a plain `git worktree remove -- <path>`
(`remove_worktree` in `src-tauri/src/git_cmd.rs`) with no `--force` — safe
only on a clean worktree, so a user with uncommitted changes is stopped by
git itself rather than silently losing work.

## Consequences

- The prompt file is a small, transient artifact under `~/.claude/kriyon/run/`;
  it is not cleaned up proactively by this arc (left for a future pass if it
  becomes clutter).
- An archived Session still occupies its working directory/worktree until the
  user explicitly removes it — intentional, since Kriyon has no reliable
  signal that a worktree is safe to delete beyond "merged cleanly."
- Both decisions favor **not doing anything destructive automatically** over
  originally faster-looking options (typed injection, forced cleanup),
  consistent with the project's stance that the terminal/transcript is the
  source of truth.
