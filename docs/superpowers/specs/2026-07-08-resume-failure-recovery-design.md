# Resume-failure recovery — design

**Date:** 2026-07-08
**Status:** Implemented

## Context

When a [Session] has a persisted [Claude session id], Kriyon launches it with
`claude --resume <id>` (`sessionHost.ts:launchClaudeOnce`). If that conversation
has **expired** (Claude's retention window; an overnight gap easily crosses it),
Claude prints "session expired" and exits back to the shell prompt. Kriyon does
nothing: it typed the command and never learns the resume failed, so it neither
clears the loading state nor offers a way forward. The user is stuck at an error
and must type `claude` manually — the reported "morning bug".

(The separate cause — Kriyon persisting the *wrong* claude id — is already fixed
by the converging [Main session lock].)

## Goal

When a resume fails, recover with a clear, one-tap path: tell the user the
conversation expired and let them start a fresh session in the same terminal.
Reliable detection with no false positives on a normal (slow) resume.

## Scope

- **In:** resume launches only (`claude --resume`).
- **Out:** a *fresh* `claude` that fails to boot — "start fresh" would just fail
  again, so there is nothing useful to offer. No retry button, no prompt
  re-seeding (see the brainstorm; deliberately cut for simplicity).

## Detection (approach C — hybrid)

A resume is "failed" when, **while the session is still `booting`** (no
`SessionStart` hook has fired), **either**:

- Claude's process exits — surfaced by the existing per-session `onBusy(false)`
  transition (Claude is the shell's foreground process). This is the **primary**
  signal: a genuinely expired conversation makes Claude error and exit in ~1s, and
  we only count the exit once we've seen Claude actually run (`resumeSawBusy`), or
- a **20-second** timeout elapses since the resume was written — a backstop for the
  rare case where the exit is missed. It matches the generic boot timeout so a
  slow-but-fine resume never false-flashes.

Whichever fires first wins. The `SessionStart` hook (which already flips
`booting → false` and dismisses the loading overlay) **disarms** detection, so a
normal resume — however slow to render — can never trip it. Reattached and
already-launched sessions never arm detection.

**Note (from the real-app smoke):** on the current Claude CLI, resuming a
*non-existent* id does **not** stick — Claude ends the bad id and auto-starts a
fresh session (`SessionStart` fires), which correctly disarms the watchdog (no
overlay). The recovery prompt is therefore reserved for the true *expired* case,
where Claude exits without ever firing `SessionStart`.

## Components & data flow

- **`sessionHost.launchClaudeOnce`** — on the resume path only, mark the host
  `awaitingResume` and start the 8s timer. On a fresh/seeded launch, do nothing
  new. Expose a way for the store to disarm (on `SessionStart`) and to be told
  "Claude exited" (from the busy handler).
- **`sessions.ts` store** — add `resumeFailed: Record<string, boolean>`. Set it
  when the detector fires; clear it on `SessionStart`, Start fresh, or Dismiss.
- **Overlay** — a minimal pane overlay reusing the existing loading/needs-you
  overlay pattern and `theme/tokens.ts`. Copy: **"Couldn't resume this session —
  the Claude conversation has expired."** Buttons: **[Start fresh]** primary,
  **[Dismiss]** secondary.

## Actions

- **Start fresh** — clear the session's persisted `claudeSessionId` (so it never
  retries the dead id), then launch a plain `claude` in the same terminal. The
  new session's `SessionStart` clears `resumeFailed` and the overlay.
- **Dismiss** — hide the overlay and leave the shell at the prompt. **Sticky:**
  stays dismissed until the next launch (does not reappear for this run).

## Error handling

- Disarm is idempotent; a late busy/timeout after `SessionStart` is a no-op.
- If `Start fresh`'s launch itself fails, the existing session-error path applies
  (unchanged) — we do not loop the overlay.

## Testing

- Detector fires on exit-before-ready; fires on timeout with no `SessionStart`;
  does **not** fire when `SessionStart` arrives first (slow-but-ok resume).
- Start fresh clears the stored `claudeSessionId` and writes `claude\r`.
- Dismiss hides the overlay and is sticky for the run.
- A fresh (non-resume) launch never arms detection.

## Decided defaults

- Timeout: **20s** backstop (busy-exit is the primary, ~1s signal).
- Dismiss: **sticky until the next launch**.
- Recovery-clear lives in the `SessionStart` listener, not `markReady` — so the
  boot-timeout fallback (which also calls `markReady`) can't erase a real failure.
