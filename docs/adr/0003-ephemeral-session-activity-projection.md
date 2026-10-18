# ADR 0003 — Session activity is a derived, ephemeral projection of live signals

**Date:** 2026-06-17
**Status:** Accepted (revised 2026-06-17 — see "Revision" below)

## Context

The Inspector shows three live views — running Subagents, Background shells, and
the Task list — collectively the Session's [Session activity]. These are
*stateful*: they need correlation (an Agent start matched to its completion, a
task's create matched to its updates), unlike the Studio view's append-only
`StructuredEvent` stream. The React frontend is a thin UI that must not own that
logic.

## Decision

Session activity is **derived and ephemeral** — never persisted to SQLite. It is
rebuilt from the session's live signals each time Kriyon attaches, and the pure
correlation logic lives in `kriyon-core` (TDD-tested), not the frontend. The
watcher assembles a `SessionActivity` snapshot and pushes it to the store
exactly like the usage snapshot; the store keys it by `SessionId`; the Inspector
renders it.

## Revision (2026-06-17): the source is live signals, not the transcript

This ADR originally derived activity by **replaying the main transcript**
(`~/.claude/projects/<proj>/<id>.jsonl`). That assumption was wrong for current
Claude Code: **as of 2.1.179 the main transcript is not written while a session
is live** (it lands later), and the per-session path became a *directory*. So a
transcript-replay projection showed nothing during an active session.

The decision (ephemeral, core-owned projection) stands; only the **source**
changed to signals Claude Code does write live:

- **Subagents & Background shells** ← the Claude Code **hook events** Kriyon
  already installs. An `Agent` `PreToolUse` opens a running Subagent keyed by
  `tool_use_id`; the matching `PostToolUse` completes it (carrying its result and
  end time). A background `Bash` `PreToolUse` opens a shell. Kriyon's hook was
  extended to record `tool_use_id`, `subagent_type`, `description`,
  `run_in_background`, `command`, `result`, and a timestamp. Logic lives in
  `kriyon_core::activity::HookActivity`.
- **Tasks** ← the task store `~/.claude/tasks/<session-id>/<n>.json`, read by the
  watcher each pump (`parse_task_file`).

The transcript still feeds the Studio view; it is simply no longer the activity
source. The old transcript-replay projector was removed.

## Revision 2 (2026-06-17): drop `--session-id`; learn Claude's id from hooks

Investigating an empty Studio view sharpened the transcript finding above. The
main transcript is **not** universally broken in 2.1.179: a normally-launched
`claude` writes `~/.claude/projects/<enc>/<id>.jsonl` live and in full. The real
cause was Kriyon launching `claude --session-id <kriyon-uuid>` to force Claude's
id to equal Kriyon's ("unify session identity"). Handing Claude a fresh,
externally-supplied id triggers a Claude Code bug (issue #20612): the registry
points at `<id>.jsonl` but that file is never written — only a `<id>/` directory
(subagent meta + tool results) appears. So every Kriyon session had a phantom
transcript path, and the Studio view (which tails the hook-reported
`transcript_path`) stayed empty.

**Decision:** stop forcing the id. Launch plain `claude` (still with
`KRIYON_SESSION` set, which gates the hook). Claude keeps its own session id and
writes its transcript live again. Identity now flows **from** Claude via the
hook rather than being forced **into** it:

- **Events & usage** stay keyed by Kriyon's launch id (`KRIYON_SESSION`), since
  those sidecar files are Kriyon-owned and named before Claude's id exists.
- **Studio transcript** ← the hook's `transcript_path` (now a real, live file).
- **Tasks** ← `~/.claude/tasks/<claude-id>/`, where `<claude-id>` is learned
  from the new `session_id` field on hook events (the task store is keyed by
  Claude's id, not Kriyon's). The watcher binds the task dir lazily from the
  first hook line carrying a `session_id`.

This keeps a single canonical identity end-to-end (sourced from Claude) without
the `--session-id` hack that broke the transcript.

## Revision 3 (2026-06-17): persist Claude's id and resume on reopen

Dropping `--session-id` (Revision 2) fixed the live transcript but left sessions
only half-restored across app restarts: the Studio view replayed the transcript,
but the terminal opened a *plain shell* (no `claude`), and the sidebar title
stayed the cwd basename. Three additions close the gap, all flowing **from**
Claude via the same hook/transcript stream this ADR established:

- **Claude session id is persisted.** The watcher already learns Claude's id from
  the first hook carrying `session_id` (to locate the task store); it now also
  emits it (`session-claude-id`), and the frontend persists it on the session row
  (`SessionRow.claude_session_id`). This is the one durable fact needed to resume.
- **Terminal resumes on first view.** A session launches `claude` the first time
  it is viewed (including the one active on startup) — `claude --resume <claude-id>`
  when an id is known, plain `claude` otherwise. `--resume` of a *Claude-generated*
  id is safe (unlike the banned `--session-id` of a *fresh* id) and appends to the
  same transcript, so terminal and Studio view stay continuous.
- **Studio events carry a stable id.** Resuming re-tails the whole transcript from
  the start, so every emitted event is now a `StudioEvent` tagged
  `<line-uuid>:<block-index>`; the store dedupes by it, making replay idempotent.
- **Title comes from `ai-title`.** The transcript's `ai-title` line (Claude's own
  session label) is parsed and emitted (`session-title`) to fill the sidebar title,
  with the cwd basename as the pre-title fallback.

Activity stays ephemeral (the original decision); only the durable session
identity/title became persisted.

## Consequences

- Activity is live during a session (hooks fire per tool call), not only after
  the transcript flushes.
- Kriyon now depends on its own hook capturing a few extra fields; the hook is
  re-installed on launch, so the dependency is self-contained.
- Background-shell completion is still unavailable (hooks carry no signal for it)
  — see ADR 0002.
- Tied to Claude Code's on-disk layout (`~/.claude/tasks`, hook payload shape),
  which can change between versions; the parsers are tolerant and degrade to
  empty rather than erroring.
