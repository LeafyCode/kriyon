# ADR 0022 — Session processes end on intent, survive accidents

**Date:** 2026-09-20
**Status:** Accepted
**Supersedes:** the "Session daemons deliberately survive quit" rule from the PTY-daemon arc
(`docs/superpowers/specs/2026-06-20-pty-daemon-and-worktree-diff-merge-design.md`)

## Context

Each [Session] runs under its own out-of-process [PTY daemon] so it outlives an app crash.
That part works and stays. What did not work was everything around *ending* a session:

- Closing signalled the shell pid alone. Anything in its own process group, backgrounded, or
  ignoring SIGHUP was reparented to launchd and ran forever, untraceable.
- Closing a session this run had never opened sent nothing at all: `close_session` returned
  "session not found", the frontend swallowed it, and the row was deleted.
- Archiving set a flag. Quitting stopped nothing, by design. After a relaunch, surviving
  daemons nobody clicked were invisible to the memory chip, the budget warning and
  auto-sleep. Nothing ever reaped a daemon whose row was gone.

`proc.rs` said it out loud: "dozens of daemons are alive for sessions last touched days ago."
An idle `claude` is on the order of half a gigabyte.

Research (spec §2) found the same failure in many tools in this category, with the same root
cause: signal the PTY root, lose the tree. It also found little demand for local agents to
survive a *deliberate* quit; keep-alive is wanted for crashes and updates. One tool that keeps
everything alive after quit names that choice as a leak cause in its own root-cause document.
iTerm2 is the precedent for the split we adopt: jobs in server processes survive a crash,
force-quit or upgrade, and ⌘Q kills them.

## Decision

**Intent decides.** A deliberate gesture ends processes. An accident leaves them running to be
reattached. The conversation survives either way (`claude --resume`), so the only thing a stop
ever costs is a turn in flight or a background command — and that is exactly what we ask about.

1. **A daemon only ever exits by [Tree stop].** Snapshot the [Stop target]s before signalling
   (the shell's descendants ∪ the shell's kernel session — each covers the other's blind spot),
   SIGHUP the shell and SIGTERM the rest, wait a bounded grace, re-sweep, SIGKILL whatever is
   still the same process. On `Shutdown`, on the shell dying, and on SIGTERM. It lives in the
   daemon, so the app fires a frame and never waits: quit stays instant.
2. **Every signal passes one [Signal gate]** — never pid ≤ 1, never ourselves or an ancestor —
   and targets come only from a sweep just taken, never a pid read from disk. A stale pid can point at
   an unrelated process; one terminal app killed dozens of unrelated processes this way.
3. **Close and archive stop the session, attached or not.** Quit stops every session, from
   `RunEvent::Exit` — the one event every orderly exit reaches on macOS, including the ungated
   Dock quit. A crash reaches nothing, which *is* the [Handover].
4. **The quit gate asks only when something would be lost**, and names it. Its only choice is
   whether to quit at all — *Cancel* or *Stop and quit*. Closing asks on the same [Stop cost].
   There is no "close but keep it running", and no "quit but keep that turn going": a process
   with no window owning it is how orphans are made. To keep a dev server, keep the session.
5. **At launch the app reaps [Orphan daemon]s, then adopts the survivors** ([Daemon
   adoption]); the reaper also runs on the ticker. It acts only on a daemon no row owns, needs
   two consecutive sightings on the ticker, asks before it forces, and reaps nothing when
   ownership is unreadable. Ownership is derived in Rust from the store, never supplied by the
   frontend: a failed hydration would otherwise read as "nothing is owned".
6. **One run dir per app identity.** The smoke build has its own store and therefore owns none
   of the released app's sessions; in a shared run dir each build's reaper would stop the
   other's live sessions. The released identifier keeps `run`, so an update still finds the
   daemons its predecessor left.

## Rules this creates

- **A stop is never a close.** A process dying — at quit, at reboot, from a signal — changes no
  persisted state. Only the explicit close gesture deletes a row. Reading "every pane died" at
  reboot as "the user closed everything" would wipe every session.
- **A failed probe never stops an owned daemon.** Unreachable and owned means leave it alone.
  Otherwise a timed-out liveness probe after an update would kill every shell.
- **Never unlink a live daemon's socket.** The daemon binds only to a path that is absent or
  provably dead; `create_session` retires a live-but-unreachable daemon before it spawns.
- **[Daemon frame]s are append-only** — never renumbered, never re-shaped. A new app attaching
  to an old daemon is routine (a handover across an update), and `FrameDecoder` skips tags it
  does not know. No version handshake until a frame needs one.
- **Only the run dir's owner acts on a daemon it does not provably hold.** A daemon serves one
  client; every other connection waits in its accept backlog, and a frame written there is read
  *later* — whenever the real client next lets go. A dev build shares the installed app's
  identifier, store and run dir, so without this rule its quit would leave a `Shutdown` queued
  in every daemon the installed app is using, to be obeyed the next time that app reloaded or
  first opened the session. So exactly one running instance holds the run dir's `flock`; only
  it reaps, adopts, or stops an unheld daemon. Any other instance may stop only a connection
  the daemon has *proven* accepted, by greeting it (`may_stop_held`), and otherwise just lets go.
- **A daemon becomes unreachable before it stops.** It unlinks its socket, *then* runs the
  [Tree stop] — which can take seconds. Otherwise a quick relaunch reattaches to a dying daemon,
  skips launching `claude` because it "reattached", and is left holding a dead pane.
- **SIGKILL only from a sweep taken that instant.** Never from an earlier survey, never from
  the app's cached process table. If the table cannot be read, nothing is forced: a rare leak
  beats a wrong kill. The shell's pid is a root only while the sweep shows it is still the
  daemon's child — a reused pid is never stopped, and neither is anything beneath it.
- **Nothing blocks or asks in `RunEvent::Exit`.** A quit dialog on a system-initiated exit
  can hang the app and block a macOS update.

## Consequences

- A background job started inside a session now dies with it. It was always counted in the
  [Session footprint]; the close and quit warnings name it first. Called out in the changelog.
- Every session now resumes at every launch instead of reattaching, so the resume path is the
  main road. The persisted [Claude session id] already follows the live one
  (`WatchSignal::ClaudeId`), and the resume-failure recovery already exists.
- "Stop everything without quitting" is *Sleep idle sessions now* — the existing [Sleeping
  session] machinery with the idle threshold waived — rather than a second stopped state with
  its own UI.
- The [Detached lease] (spec §5.7) bounds a handover nobody returns to. Until it ships, such a
  daemon lives until the next launch adopts or reaps it.
- The update restart planned in the release-cycle spec is a [Handover]: it sets the intent and
  must use `request_restart()` — `restart()` on the main thread skips the exit events.

## Amendment (2026-09-20) — the quit gate offers no third way

Decision 4 originally gave the quit dialog three buttons: *Cancel · Let them finish · Stop and
quit*, with `LetWorkingFinish` sparing sessions mid-turn. Removed after the first real-app smoke
run: **the quit gate's only choice is whether to quit at all.**

The label promised something the design could not mean. "Let them finish" read as *keep the app
open until the work is done*; what it did was quit immediately and leave detached daemons behind,
which the [Detached lease] then stopped up to 30 minutes after the turn had already ended. Two
buttons that both quit, distinguished only by what they abandon, is a choice about the sessions
dressed up as a choice about the app.

What replaces it is what a user actually has: wait at the desk for the turn to end, then quit. The
cost is real but small — the conversation always resumes (`claude --resume`), and the dialog still
names the background commands that do not.

`QuitIntent` is now `StopAll` (every quit gesture) or `Handover` (an update restart, set by the
app). `spares()` no longer needs a status or a process-table reading, so `claude_in_foreground`
and the "a killed claude froze its status at `running`" veto are gone with it — that veto existed
only to stop `LetWorkingFinish` sparing a session whose turn was already dead. `ConfirmDialog`
loses its `alternative` slot, which had no other caller.

The [Detached lease] keeps its job: it still bounds a [Handover] nobody returns to.
