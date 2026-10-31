# ADR 0052 — Park a project: stop everything in it, keep everything about it

**Date:** 2026-10-31
**Status:** Accepted

## Context

People keep several projects in Kriyon and work on only some of them on a
given day. A project they are not working on still sits in the sidebar, and
its sessions and project terminals (dev servers, watchers, builds) keep
running. On a laptop that costs battery: on 2026-10-31 one machine went from
80% to 36% in about 70 minutes with about 15 sessions, two Kriyon builds, and
dev servers from projects nobody was using that day.

What exists today does not fit:

- **Archiving a session** stops its processes and keeps the conversation, but
  it works one session at a time and moves each session out of its project
  into the "Archived" group. Archiving every session of a project to put it
  away would scatter it, and bringing it back would mean un-archiving each.
- **Clear project** closes every session. That is a delete, not a pause.
- **Inactive project** folds a project away automatically when all its
  sessions are old. It stops nothing, and it comes back on its own when any
  session gets activity.
- **Sleeping a session** stops `claude` but keeps its daemon and shell. It is
  automatic and per session.

What people ask for in similar tools (T3 Code discussion #16166, a Claude Code
desktop sidebar request, Conductor's archive and History pane) is the same
shape: put a whole project out of sight without losing its conversations,
find it again easily, still read it without restoring it, and bring it back
in one step. One report against Claude Desktop shows the opposite risk:
an auto-archive that killed running work with no way back.

## Decision

- **Parking is per session; *Park project* parks them all.** *Park project*
  in the project menu sets `parked_at` on every session row still on the
  project's rail group. *Unpark* clears it on all of them. Opening one parked
  session clears it on that one only (and on its leads, if it is nested), so
  picking one session back up doesn't bring a whole project's sidebar back.
  A flag on the project row was tried first; it made opening one session
  bring back dozens. The
  word is "park" because it is short and plain for people who read English as
  a second language.
- **Parking stops everything the project runs.** Every session in the project
  and every project terminal it owns gets the same stop archiving uses (a
  tree stop of its PTY daemon). Archived sessions are already stopped.
- **Parking keeps everything about the project.** Session rows, titles, order,
  nesting, archived state, transcripts, worktrees and the terminal tab layout
  are unchanged. Parking is not archiving and not closing: it writes a
  timestamp on each session it parks.
- **Parking never kills work silently.** Before stopping, Kriyon reads the
  existing Stop cost for every session in the project and the busy state of
  every project terminal. If anything is mid-turn, running a background shell
  or subagent, holding unsent text, or running a busy terminal, a Confirm
  dialog names it. Nothing busy means no dialog.
- **Parking is the person's choice and only the person undoes it.** No timer
  and no activity brings a parked session back. The Unpark control brings all
  of a project's back; opening one from anywhere (the Parked section, ⌘K, a
  notification) brings back that one. Opening a session is what launches it,
  so the store's `setActiveSession` unparks it — one place, so no path can run
  a session that stays hidden. A new session in the project simply joins the
  rail; the parked ones stay parked.
- **Unparking is lazy.** The group returns as it was. Each session resumes
  with `claude --resume` only when it is opened, and each terminal pane opens
  a fresh shell when shown. Restarting all of them at once would bring back
  the cost parking removed.
- **Parked sessions are not live sessions.** They are excluded from the
  Command center, the Needs-you rail, the quit warning and the nested-session
  cap. The orphan-daemon sweep treats them like archived rows, and treats the
  terminal panes of a project with no session left on the rail as unowned, so
  anything that outlives a park is reaped.
- **Parked sessions stay findable.** The Parked section lists each project's
  parked sessions as its rail group showed them (same order, folds and
  nesting), and ⌘K still lists them, marked "Parked". Opening one brings back
  only it. A read-only view that doesn't unpark was considered and left out:
  it would need a session view with no terminal, which Kriyon doesn't have.
- **One "put away" check.** Archived and parked sessions are both "put away"
  (`isPutAway` in the frontend, `SessionRow::is_put_away` in Rust). Every surface that means "skip what is not live" asks it, so a
  later surface can't skip archived sessions and forget parked ones.

## Consequences

- A project has a third out-of-sight state beside Inactive (automatic, no
  stop) and Cleared (closed). The sidebar keeps them in separate places so
  each one's rule stays visible: Inactive in its fold, Parked in its own
  section, Archived sessions in their group.
- Processes Kriyon did not start (Docker containers, services started outside
  Kriyon) keep running. A per-project "on park" command, like the existing
  setup command, could stop them; it is left for later.
- `sessions` gains one nullable column, added through the existing
  `migrate_column`, so older stores read as "not parked".
