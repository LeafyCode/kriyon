# Session resume: correct status + loading overlay

**Date:** 2026-06-18
**Status:** Design approved, pending implementation
**Branch:** `feat/session-activity`

## Problem

When the app restarts and a session resumes, two things are wrong:

1. **The session lingers in "working" state** longer than it should — sometimes
   until the user interacts.
2. **There is no loading affordance** while the resumed terminal boots, so the
   window looks idle/broken during the gap.

Both are the *same window*: the gap between issuing `claude --resume` and the
resumed Claude actually being up and idle.

## Root cause

1. The per-session hook-events file `~/.claude/kriyon/events/<id>.jsonl` is
   **append-only and never reset**, keyed by a stable Kriyon session id. On
   restart the watcher's `Tailer` starts at `offset = 0` and **replays the entire
   previous run's history** (`src-tauri/src/watcher.rs`).
2. The `StatusTracker` latches `hook_driven` on the first hook line and then
   returns the status of the **last replayed line**, bypassing the time-based
   idle heuristic (`crates/kriyon-core/src/status.rs:210-216`). If the previous
   run was quit mid-turn, that line is `UserPromptSubmit`/`PreToolUse` →
   `Running` → the UI shows "working".
3. `claude --resume` is typed into the shell and takes a few seconds to boot.
   Only when the resumed Claude fires a **live `SessionStart` hook** (→ `Idle`)
   does the stale "working" clear. That delay is the lingering the user sees.

The same window has no UI covering it — the missing overlay.

A resumed `claude` reliably fires a `SessionStart` hook that Kriyon captures: the
event is registered (`src-tauri/src/hooks.rs:21`), the launch command sets
`KRIYON_SESSION` inline so the hook is gated on (`src/terminal/sessionHost.ts`),
and the event carries `transcript_path` + Claude's session id. That single live
event is the natural "terminal resumed and ready" signal.

## Principle

Historical hook lines describe a process that no longer exists. On resume we
ignore them and start clean from the live `SessionStart`. That one event both
fixes the status and dismisses the overlay — no timers guessing, no heuristics.

## Design

### 1. Backend (Rust)

**`src-tauri/src/watcher.rs` — seek the hook tailer to EOF**

- Add `Tailer::at_end(path)`: opens the file, sets `offset = file size` (0 if the
  file is absent). Hook lines are always `\n`-terminated (the hook script writes
  `json.dumps(rec) + "\n"` as one atomic append), so EOF is always a clean line
  boundary — no risk of splitting a partial line.
- `HookSource::new` uses `Tailer::at_end` instead of `Tailer::new`. **Only** the
  hook tailer seeks to end. `TranscriptSource` keeps `Tailer::new` (offset 0) so
  the Studio view still replays the full conversation; its stable-id dedup
  (`src/state/sessions.ts`) already handles re-reads.

Effects of seek-to-EOF:
- On resume the watcher ingests only **live** hook events. The tracker (fresh on
  each app start, defaulting to `Idle`) is never fed the stale trailing
  `Running`, so the sidebar dot and main view both stay correct.
- The activity panel (subagents / background shells, folded from hook events in
  `ActivitySource`) also starts clean — no phantom "running" subagents from a
  previous run. This is the desired behavior on resume.
- Claude's session id and `transcript_path` are (re)learned from the live
  `SessionStart`, exactly as on a fresh start. The persisted Claude id (used for
  `--resume`) is unchanged.

**`src-tauri/src/commands.rs` (`watch_transcript`) — emit the ready signal**

- In the `on_status` closure, when `event.event == "SessionStart"`, emit a new
  Tauri event `session-ready { sessionId }` (add a `ReadyPayload` struct mirroring
  `ClaudeIdPayload`). Because the hook tailer seeks to EOF, any `SessionStart`
  the watcher sees is live, so this fires exactly when the resumed (or freshly
  started) Claude is up and idle.

### 2. Frontend

**Store (`src/state/sessions.ts`, `src/types.ts`)**
- Add a transient `booting: boolean` field to `UiSession`, default `false`.
  **Excluded from persistence** (not written by the persistence upsert in
  `src/state/persistence.ts`).
- Actions `markBooting(id)` (set `true`) and `markReady(id)` (set `false`).
- Defensive: `applyStatus` also clears `booting` — any real live status update
  means Claude is up.

**`src/terminal/sessionHost.ts`**
- `launchClaudeOnce` returns `boolean`: whether it actually launched on this call
  (it is already idempotent via the `host.launched` guard; expose that result).

**`src/App.tsx`**
- In the launch-on-view effect, when `launchClaudeOnce` returns `true`, call
  `markBooting(sessionId)`.
- Start a ~20s timeout fallback that force-clears `booting` if it is still set, so
  the overlay can never hang (covers "claude not installed", spawn failure, or a
  Claude version that does not fire `SessionStart`).
- Render the overlay inside the per-session wrapper (already `position: relative`)
  while `session.booting`.

**`src/ipc/bridge.ts` + `src/state/backendListeners.ts`**
- Add `onSessionReady` subscribing to `session-ready`; wire it to `markReady`,
  mirroring the existing `onSessionClaudeId` listener.

**Overlay (`src/ui/SessionLoadingOverlay.tsx`)**
- Absolutely positioned (`inset: 0`) over the per-session wrapper. Reuses the
  existing `Thinking` shimmer/pulse idiom and design `tokens` (glass overlay
  fill, blur, accent). Z-order sits above content but below modals/toast.
- Copy: "Resuming session…" when `claudeSessionId` is set, else "Starting
  Claude…".
- `prefers-reduced-motion` is already handled globally by `src/App.css`.

### 3. Data flow (resume, app restart)

1. App hydrates; `activeSessionId` set; `idleSession` → `status: "idle"`,
   `booting: false`.
2. `StudioView` mounts (always mounted, hidden when not shown) → `watchTranscript`
   → `spawn_session_watch` → hook tailer **seeks to EOF** (skips previous run's
   history). Tracker registered as `Idle`.
3. `Terminal` mounts → `ensureSession` (spawns the shell PTY). The launch effect
   calls `launchClaudeOnce` → types `KRIYON_SESSION=… claude --resume <id>` →
   returns `true` → `markBooting`. Overlay appears.
4. Claude boots over ~2-5s, fires a live `SessionStart` → appended to the events
   file → watcher reads it (it was seeked past history) → status stays `Idle`
   (correct) **and** `on_status` emits `session-ready`.
5. Frontend `onSessionReady` → `markReady` → overlay dismisses. The 20s timeout
   is the only fallback if `SessionStart` never arrives.

## Edge cases

- **Fresh start (new session):** events file is empty → `at_end` offset 0 →
  behaves exactly like today. Overlay still shows (until the fresh
  `SessionStart`); copy reads "Starting Claude…".
- **Claude never boots:** the 20s timeout clears `booting`.
- **Re-subscribe mid-run** (rare — `StudioView` mounts once and stays mounted):
  seek-to-EOF would skip already-seen events, but the tracker persists in
  `state.status` across re-subscribes, so the displayed status is preserved.
- **`SessionStart` from `/clear` or `/compact`:** harmless — it only clears
  `booting`, which is only set during the launch window.
- **Reduced motion:** covered by the global `App.css` reset.

## Testing (TDD — tests written first)

**Rust (`src-tauri/src/watcher.rs`)**
- `Tailer::at_end` skips pre-existing bytes and reads only lines appended after
  construction.
- `spawn_session_watch` with a pre-seeded historical events file does **not**
  drive status from that history; only live events written after subscribe drive
  status.

**Frontend (vitest)**
- `markBooting` / `markReady` transition `booting` correctly.
- `booting` is not written by the persistence upsert.
- `onSessionReady` clears `booting`; `applyStatus` clears `booting` defensively.
- `launchClaudeOnce` returns `true` on the first call, `false` thereafter.
- `SessionLoadingOverlay` renders when `booting` and is absent when ready.
- `App` marks `booting` on launch and the timeout fallback clears it.

## Out of scope

- Changing how `--resume` is invoked or how the Claude id is persisted (already
  shipped on this branch).
- Any change to the Studio transcript replay / dedup path.
- Persisting hook/activity history across restarts (activity is ephemeral by
  ADR 0003; starting clean on resume is the intended behavior).
