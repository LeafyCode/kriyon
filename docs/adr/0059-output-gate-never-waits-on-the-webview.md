# ADR 0059 — The app keeps reading every session whether or not the window draws

**Date:** 2026-11-13
**Status:** Accepted

## Context

The webview paints session output on animation frames: the [Write queue]
flushes once per `requestAnimationFrame` and reports each flush back as bytes
drained. The [Daemon client]'s reader used to park once 128 KB had been sent to
the webview but not reported drained. A parked reader stops reading the
[Session socket], so the [PTY daemon]'s socket write blocks, then its pty read,
and the program in the session pauses.

A hidden app (Cmd+H) gets no animation frames. On 12 Nov a test proved what
follows: every session in the app stopped taking output about 150 KB after the
app was hidden, and started again when it came back. A covered window was
fine. A working Claude Code session writes about 2.4 KB a second, so with the
app hidden it froze after about a minute. Remote access makes this the common
case: the desktop app is often hidden while someone uses their phone.

## Decision

- **The reader never waits on a webview that has stopped draining.** Every
  byte read reaches the Rust side at once: the session runtime's "still
  painting" clock and the sign-in refusal watch see it whether or not the
  webview takes it.
- **An [Output gate] in `kriyon-core` decides what the webview gets.** Under
  128 KB in flight, output goes straight through, as before. Above it, while
  the webview still drains, the reader waits for it, as before, so a fast
  program's output waits in the daemon's per-client queue instead of being
  dropped here. Only a burst past that queue is skipped, and the daemon's
  Output history still has it (ADR-0060).
- **After 500 ms with no drain, the webview counts as stalled** and the reader
  stops waiting. Output is then held, up to 1 MB per session, and released in
  order, 128 KB at a time, as the webview drains back to 16 KB. Past 1 MB, the
  held bytes are dropped, and so is everything after them until the webview
  catches up; the client then asks the daemon for a screen repaint. The
  daemon's emulator sees every byte, so the current screen is never lost.
- **Pacing comes back with the drains.** The reader paces again as soon as the
  webview drains again, held output or not, so one slow frame on a visible
  window does not turn into lost output. A report of nothing drained is not
  progress.
- **The cut is sealed.** Where output is dropped, the webview gets a string
  terminator and an end of synchronized output, so a sequence cut in half
  cannot swallow the repaint.

## Consequences

- A hidden, minimised or locked app no longer freezes its sessions. A session
  pauses for at most 500 ms when the window stops drawing.
- Bounded memory: at most 128 KB in the webview's queue and 1 MB held in Rust,
  per session, however long the window stays hidden.
- When output is skipped, the terminal's scrollback misses it: the repaint
  rebuilds the visible screen only. A size-limited scroll history on the host
  ("Show earlier output") is separate work.
- Between the drop and the repaint, a few stale bytes can reach the terminal
  and be drawn briefly; the repaint opens with a clear and overwrites them.
- `report_drained` is an async command whose work runs on the blocking pool:
  it can wait on the reader's lock, hand the webview a slice of held output,
  or write a repaint request, none of which may happen on the main thread.
- Not solved yet, both because a repaint arrives as ordinary `Output`: the
  repaint's bytes count as fresh session output (the "still printing" clock,
  the refusal watch), and output read between the cut and the repaint is
  drawn on the old screen until the repaint clears it. Both need the daemon to
  mark its screen snapshot with a frame of its own.
- The daemon never blocks on the app either: it queues each client's output
  and skips ahead when the queue is full. So the child is paced by no one; the
  gate only decides how much reaches the webview, and in what order.

## Update 2026-11-14 — remote onlookers, and the screen apart from output

Remote access adds a second kind of reader of a session's output, and the
reader's waits for the window must not reach it (ADR-0057).

- **One hook, before any wait.** The [Daemon client]'s reader hands every
  frame, in order, to one listener (`on_event(DaemonEvent)`) before the
  webview's pacing can wait. The remote layer and the app's own listeners
  (the "still printing" clock, the refusal watch, busy state) all read there.
- **Pacing only while no remote device looks on.** While nobody remote
  watches, the reader paces by a draining window as before, so the desktop
  alone still gets every byte of a fast program. While a remote device is an
  [Onlooker] of the session (`set_remote_onlooker`, fed by the remote layer;
  a per-session flag until `Onlooker::Device` exists), the reader never waits:
  the daemon is no longer slowed by the window, and the window's gate holds up
  to 4 MiB (`WEBVIEW_ONLOOKED_HOLD_CAP`, the size of the daemon's Output
  history) before it cuts and repaints, so "Show earlier output" can back-fill
  a cut stretch.
- **The screen comes apart from output.** The daemon sends the app's
  terminal its [Screen snapshot] as `Screen` frames, opened by `Hello { run }`
  (the [Session run]). A repaint no longer counts as fresh output for the
  "still printing" clock or the refusal watch. After a cut, once the daemon has
  said `Hello`, the gate drops output read between the repaint request and the
  `Screen` that answers it, so nothing is drawn on the old screen. A daemon
  from before this change sends neither, and the gate behaves as before.
- **A snapshot for one requester.** A remote device's snapshot comes from
  `RequestSnapshot { id }` and `Snapshot { id }` frames, queued in order with
  the output; the app's own terminal is not repainted for it. History answers
  carry the requester's id the same way.

The second "not solved yet" consequence above is now solved for a daemon of
this version.

