# ADR 0009 — Converging main-session lock, anchored by the status line

**Date:** 2026-07-08
**Status:** Accepted

> **Superseded in part by [ADR-0019](0019-remove-the-structured-pane.md)
> (2026-08-05).** This ADR's framing — that the lock must serve *two* surfaces,
> [Status] and the Structured view — no longer holds: the structured pane is
> gone. The lock's second owner is now `HookActivity` feeding
> [Session activity] (the Inspector), which needs it for exactly the same
> reason. The decision, the convergence rule, and the status-line anchor are
> unchanged; only "the Structured view" below should be read as "the live
> activity projection".

## Context

Kriyon keys one hook-events file per **terminal**
(`~/.claude/kriyon/events/<KRIYON_SESSION>.jsonl`). But a terminal's file
accumulates events from *many* [Claude session id]s over its life: the main
interactive session's id changes on every restart / resume / `/clear`, and
nested claudes — subagents and one-shot `claude -p` invocations — inherit
`KRIYON_SESSION` and append their own `SessionStart`/`Stop`/`SessionEnd` into the
same file. A real terminal was observed cycling through **ten** distinct claude
session ids.

[Status] and the [Structured view] (`HookActivity`) must reflect the **main**
interactive session only: a nested claude finishing must not flap the main
session's status Done↔Idle, and the first subagent to finish must not settle its
still-running siblings.

The original rule (in both `StatusTracker` and `HookActivity`, hand-duplicated):
lock onto the **first** session id seen after the watch subscribes, and only
ever re-lock on an `Agent`/`Task` spawn. Two failures followed:

1. **Stuck lock (the bug that prompted this).** The watch seeks to EOF on
   subscribe, so the first *post-subscribe* line wins the lock. If that line
   belongs to a session that ends immediately (or to a nested one-shot), and the
   real interactive session never spawns an `Agent`, every one of its events
   fails the `session_id == main` check and is dropped **forever**. The session
   shows idle in the sidebar and tray while it is actively working.
2. **Two copies of the rule.** The status badge and the structured view each
   carried their own `main_session` field and `is_main_session`, with a comment
   asking a human to keep them "matching exactly" — a standing invitation to
   drift.

## Decision 1: one converging `MainSessionLock`, shared

Extract a single [Main session lock] (`kriyon-core::main_session`) that both
`StatusTracker` and `HookActivity` own. It **converges** on the live session
instead of latching once. `observe(event) -> bool` returns whether the event is
the main session's; it re-locks when:

- nothing is locked yet, **or**
- the current main has emitted `SessionEnd` (a new session supersedes it), **or**
- the event is an `Agent`/`Task` spawn (authoritatively the main agent, since
  subagents don't spawn agents — self-heals a resume that began mid-subagent).

A candidate must be *lockable*: not a one-shot `claude -p`, detected by its
transcript landing outside `~/.claude/projects/…` (a one-shot writes to a temp
dir). A **live** (un-ended) main is never displaced by another session's events,
so a nested claude can't flap it. The legacy no-session-id stream is still
honored only while no lock has been taken.

This fixes the stuck lock: an ended early session releases the lock, and the
live session's next event claims it. Because both surfaces now share the one
type, they cannot disagree about which events are the main agent's.

## Decision 2: the status line is the authoritative anchor

The heuristic converges but still depends on a `SessionEnd` arriving to release a
stale lock — a hard restart or `/clear` may not emit one. So we add a trusted
signal: Claude's `statusLine` JSON carries the interactive session's `session_id`,
and **only the main interactive TUI renders a status line** — a one-shot
`claude -p` and subagents do not. The [Status-line] wrapper (`kriyon-usage.py`)
captures that id into the usage snapshot; `status_rt` feeds it to
`MainSessionLock::set_authoritative`, which re-anchors immediately, correcting a
heuristic mis-lock and covering the restart-without-`SessionEnd` case.

This reuses the existing usage-snapshot watch rather than adding a new file or
watch source: the id rides along on a signal Kriyon already tails.

## Consequences

- Status and activity always settle on the live session and cannot get stuck,
  even after a terminal cycles through many nested/ended claudes. The behavior is
  pure and unit-tested in `kriyon-core` (the lock's own tests plus a
  `StatusTracker` regression replaying the observed ten-session sequence).
- The anti-flap guarantee is preserved and now proven in one place instead of
  two: the pinned nested-claude / agent-relock / legacy-no-id tests still pass,
  moved onto the shared lock.
- `UsageSnapshot` gains an optional `sessionId` field (Rust + the mirrored TS
  type). It is a status-anchoring signal riding on the usage channel; the
  frontend ignores it. A future cleaner split (a dedicated main-session signal)
  is possible but not worth a second watch today.
- The same convergence now backs the persisted [Claude session id] and the
  task-store dir: `ActivitySource` binds them from the projection's converged main
  session (re-emitting a corrected id), and the pump anchors that lock from the
  status-line id too. So `claude --resume` targets the live session, not a
  first-seen nested/ended one — closing the "resume a dead session next launch"
  path. What remains separate is *recovery when a resume still fails* (a genuinely
  expired conversation): Kriyon types `claude --resume <id>` and, if Claude errors
  out, leaves the shell at the prompt instead of falling back to a fresh session.
  That is a launcher concern (`sessionHost.ts`), not the lock's, and is tracked
  on its own.
