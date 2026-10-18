# Terminals and the PTY daemon

The terminals Kriyon hosts and the daemon process that keeps each PTY alive.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Project terminal** — a plain login shell the user runs inside a [Project (Workspace)] for
  dev servers, builds, and logs. Reuses a [Session]'s PTY plumbing ([PTY daemon], [Session
  socket], [Daemon client]) but hosts no `claude`: no [Transcript], no [Status], no sidebar
  entry. _Avoid_: "task terminal" (collides with [Task]), "utility session".
- **Warm pane** — a [Session] whose Raw-view xterm stays mounted (hidden) after the user switches
  away, so returning to it never remounts and blanks the terminal. Bounded: only the
  `MAX_WARM_PANES` most-recently-left sessions stay warm (LRU); past that the xterm unmounts to free
  its WebGL context (WKWebView caps live contexts ~16), while the [PTY daemon] lives on so a later
  return reattaches instead of rebooting. The active [Session] is always mounted without being a
  warm pane. _Avoid_: activated id (the old unbounded set), kept-alive tab.
- **Terminal tab** — a named group of one or more [Terminal pane]s within one Project.
- **Terminal pane** — one [Project terminal] in a split. Backed by its own [PTY daemon], keyed
  by a fresh Kriyon UUID (same id type a [Session] uses as its socket key).
- **Terminal workspace** — the shared component + store rendering tabs and panes; mounted in
  both the [Terminal dock] and the [Terminal view].
- **Terminal dock** — the resizable bottom-panel host in the workspace center column.
- **Terminal view** — the full-height top-level [Terminal workspace] host in the view switcher.
- **Link target** (`LinkTarget`, `linkTarget`, `openLinkTarget`) — what a clicked link in the
  [Raw view] or the [Structured view] points at: an http(s) URL for the browser, or a file path
  (relative, absolute or `file://`) the Rust `open_path` command re-validates. Anything else
  (`mailto:`, `#anchor`) is not a link. _Avoid_: href.
- **Raw view** — the full xterm.js terminal showing verbatim PTY bytes. The source of truth, and
  the only rendering of the conversation Kriyon has: the reconstructed structured pane that used to
  sit beside it was removed (ADR-0019). Its tab is labelled **Session** since ADR-0023; the code
  and the persisted `transcriptView` value keep `raw`.
- **Block** — an OSC 133 command/output region in the terminal (command-start `C` → command-end
  `D`), used for per-command grouping and clean "copy this output".
- **Engine** (`SessionEngine`) — the trait abstracting how a session is driven. `PtyEngine` (v1,
  interactive, subscription auth). `ApiEngine` (future, API-key, headless) — designed-for, not built.
- **Write queue** (`WriteQueue`) — the frontend buffer that coalesces incoming PTY output
  (`Uint8Array` chunks) and flushes them to xterm once per `requestAnimationFrame` via a single
  `term.write` of the concatenated bytes, instead of one write per channel message. Each flush
  reports the byte count it consumed (see [Drained counter]) so the reader can resume. _Avoid_:
  render buffer, frame buffer.
- **Backpressure** — the Rust PTY reader's flow control on the output path. It tracks
  `pending = sent − drained` bytes; when `pending` exceeds the high-water mark (128 KB) the reader
  thread parks on a condvar, resuming once it falls below the low-water mark (16 KB). Keeps a fast
  `claude` from outrunning the renderer without dropping or reordering bytes. _Avoid_: throttle,
  flow control (ambiguous with terminal XON/XOFF).
- **Drained counter** (`report_drained`) — the per-[Session] count of output bytes the frontend has
  taken ownership of from the output channel. The `report_drained(id, bytes)` command adds to it and
  signals the [Backpressure] condvar so a parked reader can resume. `pending = sent − drained`.
  _Avoid_: ack, acknowledged bytes.
- **PTY daemon** (`kriyon-ptyd`) — the long-lived, out-of-process daemon that owns one [Session]'s
  PTY and child shell, one process per [Session], so the [Session] outlives an app crash. It
  byte-proxies output/stdin/resize over [Daemon frame]s on the [Session socket] and replays a
  [Screen snapshot] when a client reattaches. It outlives an *accident* (a [Handover]), never a
  deliberate gesture: close, archive and quit all end it, and it only ever exits by [Tree stop]
  (ADR-0022). _Avoid_: pty server, broker.
- **Run dir** (`run_dir_name`) — the directory under `~/.claude/kriyon/` holding an app identity's
  [Session socket]s: `run` for the released app, `run-<identifier>` for any other build. One per
  identity because each has its own store — in a shared dir, a build's [Orphan daemon] reaper
  would see another build's live sessions as unowned and stop them.
- **Session socket** — the per-[Session] Unix domain socket at
  `<run dir>/<session-id>.sock` the [PTY daemon] listens on and the [Daemon client]
  connects to. Keyed by Kriyon's [Session] id, which is validated before it is interpolated into the
  path (the trust-boundary path-containment rule). _Avoid_: ipc socket.
- **Daemon frame** (`Frame`) — one length-prefixed message on the [Session socket]
  (`[tag][u32 len][payload]`): `Output` / `Stdin` / `Resize` / `Attach` / `Shutdown`. Encoded and
  decoded by the pure `wire` module, which tolerates partial reads and skips unknown tags.
  _Avoid_: packet, message.
- **Daemon client** (`DaemonClient`) — the app-side [Engine] that connects to a [Session socket],
  runs the framed reader thread feeding [Backpressure] (so [Drained counter] and pacing are
  unchanged), and sends stdin/resize/shutdown frames. Implements `SessionEngine`, so the app's hot
  path does not change when the PTY moves out of process. _Avoid_: pty client.
- **Screen snapshot** (`state_formatted`) — the escape codes the [PTY daemon]'s headless `vt100`
  emulator emits to reconstruct the current screen (contents, colours, cursor, input modes), sent to
  a [Daemon client] on attach and on a repaint request so the terminal repaints even when the child
  produced nothing while detached (ADR-0004). The emulator consumes every output byte whether or not
  a client is attached, and keeps no scrollback — only the visible screen, which is all the snapshot
  serialises. It replaced the bounded output ring the daemon used to fill only while detached.
  _Avoid_: scrollback ring, replay buffer (ambiguous with the frontend's detached replay buffer).
