# ADR 0014 — One Session runtime owns status + mirrored ask; the ask rides the Status signal

**Date:** 2026-07-18
**Status:** Accepted
**Relates to:** [ADR-0003](0003-ephemeral-session-activity-projection.md), [ADR-0010](0010-two-main-session-lock-instances.md)

## Context

A session's live runtime state was split across two parallel locked maps in
`AppState`: `status` (the `StatusTracker`s) and `asks` (the mirrored open
[Pending ask] per session). Every consumer of "does this session need the
user" — the menu-bar badge, the OS-notification dispatch, the tray's session
snapshots — re-joined the two maps by hand, each repeating a "snapshot each
lock in its own scope, never hold both" ordering rule in a comment.

Two concrete bug families lived in those seams:

1. **The phantom badge** (2026-07-18): statuses folded from gappy subscription
   windows wedged a stale Waiting; the fix (history seeding) then had to
   coordinate writes across *both* maps and lost races against the live path
   (a 21-agent review confirmed a seed-vs-live ask clobber, twice over).
2. **The emit-ordering contract**: the watcher pump emitted `Ask` immediately
   before `Status` so a notification fired by the Status handler would find
   the ask already mirrored — a temporal invariant established in
   `watcher.rs`, relied on in `commands.rs`, observable in `status_rt.rs`.

## Decision

- **`kriyon-core::runtime::SessionRuntime`** owns a session's tracker and
  mirrored ask behind one interface (`needs_you()`, `status()`, `ask()`,
  `set_ask()`, `from_history()`). The shell keeps **one** map:
  `AppState::runtimes`. The badge is one pass counting `needs_you()`; the
  tray rows carry the same flag; no consumer joins maps.
- **`WatchSignal::Status { event, ask }`** carries the open ask on the status
  signal itself. The separate `Ask` variant and the emit-ordering contract are
  gone; ask + status commit atomically under the one runtimes lock
  (`status_rt::note_status_signal`), which also closes the seed-vs-live
  races structurally — the seed installs a whole runtime, and a hook-driven
  runtime always wins.
- The ask is still **computed** only by the [Session activity projection]
  (ADR-0003 stands); the runtime holds the mirrored value. The two
  `MainSessionLock` instances of ADR-0010 also stand — the runtime wraps the
  status-side instance without sharing it.

## Consequences

- `tray_badge::needs_you_count` (set-union + dedup) is deleted: one object per
  session cannot double-count, so the invariant its test pinned now holds by
  construction.
- The notification dispatch and the tray snapshot assembly
  (`session_snapshots_inner`) are testable without a Tauri app; the
  watch-signal routing table is a named module (`watch_route`) tested under
  the mock runtime.
- Anyone adding a new per-session runtime fact should put it on
  `SessionRuntime`, not in a new parallel map.
