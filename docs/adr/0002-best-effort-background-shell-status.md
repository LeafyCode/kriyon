# ADR 0002 — Background shell status is best-effort

**Date:** 2026-06-17
**Status:** Accepted

> **Note (2026-06-17):** the activity source later moved from transcript replay to
> live hook events + the task store (see ADR 0003). This decision is unchanged and
> reinforced: hooks carry no background-shell completion signal either, so a
> launched background shell shows `running` with no exit code.

## Context

Kriyon's Inspector shows a Session's running Background shells (Bash commands Claude
launched with `run_in_background`). We wanted live, accurate "still running / exit code"
status. Research into Claude Code's on-disk and hook surfaces found there is no reliable
signal for it:

- **No completion hook.** `PostToolUse` fires when the Bash tool *returns the `bash_id`*,
  not when the background process exits. No hook event signals completion.
- **No on-disk state.** Background output is buffered in `claude`'s memory; nothing is
  written to a tailable file. `~/.claude/shell-snapshots/` holds shell aliases/functions,
  not process state.
- **No PID correlation.** `bash_id` is opaque and is never mapped to an OS PID in any
  tool result, hook payload, or transcript line.

The only ground-truth exit code appears inside a `BashOutput` tool result — and only when
Claude itself chooses to poll.

## Decision

Reconstruct Background shell status **best-effort from the transcript**: record each launch
(`bash_id` + command), and update status/exit-code whenever a later `BashOutput` or
`KillShell` line carries one. Label staleness honestly in the UI ("running · last polled
2m ago") rather than implying live truth we don't have.

## Considered and rejected

- **Process-tree walking.** Kriyon owns the `zsh → claude → bash` chain and could enumerate
  `claude`'s descendant shells for a real liveness heartbeat. Rejected for v1: it can't be
  correlated back to a specific `bash_id`, it's noisy (foreground Bash tools spawn identical
  subprocesses), and it needs PID plumbing Kriyon lacks (`portable-pty`'s `Child` exposes no
  PID). Left as a possible future "all background shells are done now" all-clear only.

## Consequences

- A shell can show "running" after it has actually exited, until Claude next polls it. This
  is consistent with Kriyon's stance that the terminal is the source of truth and the
  structured view is a best-effort reconstruction — so the deviation is honest, not a bug.
- **A background shell may never be read as a claim about the session** (added 2026-09-20).
  The honesty above holds only for the shell's own row, which carries its staleness with
  it. The Details rail's Activity line had been treating "any shell exists" as work in
  flight, so a session whose status pill read `Done` could sit directly above `Working…`
  because a shell was last polled nine hours ago. Anything that speaks for the *session* —
  the Activity line, and any future badge or rollup — derives only from signals that do
  report completion: the main agent's in-flight tool, a subagent still `running`, a task
  still `in_progress`. Shells are listed, never counted.
