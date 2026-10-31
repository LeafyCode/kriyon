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

What people ask for when a tool groups work by project is the same shape: put
a whole project out of sight without losing its conversations, find it again
easily, and bring it back in one step — without running work being killed
behind their back.

## Decision

- **Parking is per session; *Park project* parks them all.** *Park project*
  in the project menu sets `parked_at` on every session row still on the
  project's rail group. *Unpark* clears it on all of them. Opening one parked
  session clears it on that one only (and on its leads, if it is nested), so
  picking one session back up doesn't bring a whole project's sidebar back.
  A flag on the project row was tried first; it made opening one session
  bring back dozens. The word is "park" because it is short and plain for
  people who read English as a second language.
- **Parking stops everything the project runs.** Every session it parks and
  every project terminal the project owns gets the same stop archiving uses
  (a tree stop of its PTY daemon). The terminals stop whenever a project
  becomes fully parked — by *Park project*, or by closing or archiving the
  last session still on the rail — because the dock unmounts that project's
  workspace, and a command left running there would be out of reach.
- **Parking keeps everything about the project.** Session rows, titles, order,
  nesting, archived state, transcripts, worktrees and the terminal tab layout
  are unchanged. Parking is not archiving and not closing: it writes a
  timestamp on each session it parks.
- **Parking never kills work silently.** Before stopping, Kriyon adds up the
  same Stop cost the quit gate reads, over the project's sessions on the rail,
  plus the busy state of every project terminal. If a session is mid-turn or
  starting, runs a background command, or a terminal is running a command, a
  Confirm dialog names it. Nothing busy means no dialog. Unsent drafts are not
  at risk: they stay in the app, and come back with the session.
- **Parking is the person's choice and only the person undoes it.** No timer
  and no activity brings a parked session back. The Unpark control brings all
  of a project's back; opening one from anywhere (the Parked section, ⌘K, a
  notification) brings back that one. Opening a session is what launches it,
  so the store's `setActiveSession` unparks it — one place, so no path can run
  a session that stays hidden. Every path that moves the selection away
  (close, archive, park) picks only a session still in sight, for the same
  reason. A new session in the project simply joins the rail; the parked ones
  stay parked.
- **Unparking starts no session.** Each session resumes with
  `claude --resume` only when it is opened. A project's terminals come back
  with fresh shells as soon as any of its sessions is on the rail again, the
  same as at app launch: the dock keeps every project's terminals mounted.
- **Parked sessions are not live sessions.** They are excluded from the
  Command center, the Needs-you rail, the project header's attention mark and
  counts, the quit warning and the nested-session cap. The orphan-daemon sweep
  treats them like archived rows, and treats the terminal panes of a fully
  parked project as unowned, so anything that outlives a park is reaped.
- **Parked sessions stay findable.** The Parked section lists each project's
  parked sessions as its rail group would show them (same order, folds and
  nesting, through one shared hook), with the folded ones a click away, and
  ⌘K still lists them, marked "Parked". Opening one brings back only it. A
  read-only view that doesn't unpark was considered and left out: it would
  need a session view with no terminal, which Kriyon doesn't have.
- **One "put away" check.** Archived and parked sessions are both "put away"
  (`isPutAway` in the frontend, `SessionRow::is_put_away` in Rust). Surfaces
  that mean "skip what is not live" ask it, so a later surface can't skip
  archived sessions and forget parked ones. "Fully parked" is decided once on
  each side of the boundary: `fullyParkedProjectIds` for the dock,
  `fully_parked_projects` in kriyon-core for the orphan sweep.

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
