# ADR 0004 — The PTY daemon holds server-side screen state for reattach repaint

**Date:** 2026-07-02
**Status:** Accepted

## Context

Each Kriyon session is backed by an out-of-process `kriyon-ptyd` daemon that owns
the PTY + child and proxies bytes to one app client at a time over a Unix socket
(so a session survives an app crash/restart and the app reattaches — see the
daemon in `crates/kriyon-ptyd`).

The daemon originally buffered a bounded **raw output ring** that was filled
*only while no client was attached*, and replayed (then cleared) on the next
attach. This works when a session produced output while detached. It fails for
the common case that surfaced in testing: **reattaching to an idle session shows
a blank raw pane.** If the child (a shell, or `claude` sitting idle in its
full-screen alternate-screen UI) produced nothing since the last detach, the ring
is empty, so a freshly-launched app — whose xterm starts empty — has nothing to
render. The real screen state lived only in the child's memory and the *previous*
client's terminal, both gone. Neither a view toggle nor a SIGWINCH reliably
forced a repaint (shells don't reprint a prompt; a same-size re-fit is a no-op),
which is exactly what reproduced live for 7-day-old sessions.

## Decision

The daemon keeps **server-side screen state**: a headless terminal emulator (the
`vt100` crate) consumes *every* byte of child output, whether or not a client is
attached. On attach, the daemon sends `screen().state_formatted()` — the escape
codes that reconstruct the current screen (contents, colours, cursor, input
modes) — then streams live bytes raw as before. The raw detached-only ring is
removed.

This is the model tmux, GNU screen, mosh, and Eternal Terminal all use: a
server-side emulator that can repaint the client on demand. The light
alternative (dtach/abduco: keep no state, nudge the child to redraw) was rejected
— it is unreliable for shells and did not repaint `claude` in live testing.

`vt100` was chosen over `avt` (asciinema) and `alacritty_terminal` because it
ships a ready `state_formatted()` serializer (the others expose only the cell
grid, forcing us to hand-roll escape-code emission). It is `vte`-backed (the
parser family Alacritty uses), actively maintained, and small.

### Consequences

- **Reliable reattach.** Any reattach repaints the exact current screen, idle or
  not — including the case where `claude` has exited into an idle login shell
  (the emulator captured the prompt). Fixes the blank past-session bug.
- **Cost is small and bounded.** One screen grid per session — the emulator is
  built with a scrollback length of `0`, because `state_formatted()` serialises
  the visible screen only, so history would be paid for and never sent. Parsing
  every output chunk through `vte` is negligible next to the existing raw copy.
  Memory is bounded per session instead of a 256 KiB ring.
- **Lock order** is `client` → `parser` everywhere (`on_output`, `attach`); the
  emulator is fed under the client lock so a snapshot can't race a half-applied
  chunk. `resize` touches only the parser.
- **Reattach snapshot is at the daemon's current size**; the client's `Attach`
  frame then resizes both PTY and emulator, so the child redraws at the real
  geometry immediately after.
- Scrollback *history* is not replayed on attach (only the visible screen);
  `state_formatted` is visible-screen-only, matching what a repaint needs.
- **`state_formatted` does not say which buffer the child is in** (added
  2026-09-20). It serialises the contents and the input modes;
  `Screen::alternate_screen()` is a getter the serialiser never consults, so the
  snapshot would paint a full-screen app's alternate grid into whatever buffer
  the client was already in. `screen_snapshot` therefore prefixes every snapshot
  with DECSET/DECRST 1049 — before the contents, since `state_formatted` opens
  with a clear. See ADR-0024 for what the divergence broke.
- Running daemons must be respawned to gain this (an already-live old-binary
  daemon keeps its old behaviour until its session's daemon restarts).
