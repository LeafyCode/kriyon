# ADR 0060 — Each session's daemon keeps an Output history

**Date:** 2026-11-13
**Status:** Accepted

## Context

ADR-0004 replaced the daemon's 256 KiB output ring with a headless `vt100`
emulator and a [Screen snapshot], and built the emulator with no scrollback,
because the snapshot serialises only the visible screen. Since then the
daemon has kept nothing of what scrolled past.

Two things now need it. A client that falls behind skips ahead to a fresh
screen (the per-client queue in `server.rs`), so whatever it missed is gone
from its terminal. And remote access promises "Skipped ahead. Show earlier
output." (ADR-0057). Neither can be met from the visible screen alone.

## Decision

- **The daemon keeps an [Output history]**: the session's most recent raw
  output, fed from every output byte whether or not a client is attached, in
  `kriyon_core::output_history`. It is separate from the emulator, which keeps
  no scrollback, as before.
- **4 MiB per session**, the same as a client's queue, so whatever a skip
  ahead dropped is still there when the client asks soon after. That is about
  40 MB across ten sessions.
- **Raw bytes, not rendered lines.** That keeps the feed a copy on the output
  path, with no second emulator. Trimmed oldest first, and to a line start
  when one is within a few KB, so a replay usually doesn't open mid-line or
  mid escape code. It can't restore colours or modes set before the cut.
- **Asked for, never pushed.** A client sends `RequestHistory` and gets
  `History` frames, split to the frame limit, closed by one `HistoryEnd`, so
  it knows when it has all of it and never draws it as live `Output`. Each
  request gets its own answer. The client's writer sends it outside the
  bounded queue, which a full history would overflow.

## Consequences

- ADR-0004's "memory is bounded per session" still holds, at 4 MiB more per
  session.
- The history can overlap the live output that follows it: bytes still queued
  for the client when it asked are in both. A reader shows the history apart
  from the live terminal, so the overlap is visible at most as a repeat.
- A daemon built before this change skips the unknown `RequestHistory` frame
  and never answers. The app side, when it is built, needs a timeout there.
- The app side ("Show earlier output") is not part of this change.
