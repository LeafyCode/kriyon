# ADR 0061 — The Companion bridge keeps a post only from a proven owner

**Date:** 2026-11-13
**Status:** Accepted
**Relates to:** [ADR-0039](0039-only-the-claude-holding-the-terminal-speaks-for-a-session.md), [ADR-0057](0057-remote-access.md)

## Context

ADR-0039 lets only the [Owning claude] speak for a session, and fails open when the check
can't run. For the [Companion bridge] that meant: every post kept off macOS, every post kept
before the daemon knew its terminal, and every post kept when the OS would not say who
posted. Remote access (ADR-0057) puts what the bridge keeps in front of other devices, so a
post from a process that merely shares the session's environment must not get through
because a check was skipped.

## Decision

- **The bridge fails closed.** A post is kept only when its sender is proven to be the
  session's owning claude. No terminal known yet, no check on this platform, or a lookup
  that failed: the post is refused. It is still answered as kept, so a mod has nothing to
  retry. The rule is `kriyon_core::bridge::check_poster`.
- **No wait before the terminal is known.** The daemon records the session's terminal before
  the session's shell starts, so no process in the session can post before it. A refusal in
  that window only ever turns away a process outside the session.
- **Linux gets the check too.** The kernel names the peer (`SO_PEERCRED`) and its
  `/proc/<pid>/stat` line gives its process group, terminal and foreground group; the
  parsing is `kriyon_core::proc::seat_from_proc_stat`.
- **Windows gets the check too** (added 14 Nov 2026). Windows has no terminal foreground, so
  the rule the daemon already uses for "the shell is busy" stands in for it: the poster's pid
  comes from the socket (`SIO_AF_UNIX_GETPEERPID`), and it owns the session when it is in the
  session's Job Object and its parent is the session's shell. A `claude` nested under the
  owner is a grandchild or deeper, and is refused. The rule is
  `kriyon_core::proc::windows_seat`.
- **Each refusal reason is logged,** at most once every ten minutes per reason, so a nested
  `claude` posting on every event does not flood the daemon's log.

The hook and status-line scripts keep ADR-0039's fail-open rule; this change is about the
bridge only.

## Consequences

- If the daemon cannot record its terminal, or the OS cannot place the poster, the
  companion stays silent for that session. The daemon's log says why.
- On Windows, a `claude` started through a launcher process (a `.cmd` shim run by `cmd.exe`)
  is the shell's grandchild, so its posts are refused like a nested one's. PowerShell, the
  session shell, runs npm's `.ps1` shim in-process and the native `claude.exe` directly, so
  the usual installs are the shell's child.
