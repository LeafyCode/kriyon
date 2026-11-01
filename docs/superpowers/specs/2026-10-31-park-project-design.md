# Park a project — design

**Date:** 2026-10-31 · **Branch:** `feat/park-project` · **Decision:** [ADR-0052](../../adr/0052-park-a-project.md)

## Goal

Let a person put away a project they are not working on today: stop every
session and project terminal in it, take it out of the sidebar, and bring it
back — all of it, or one session at a time. Glossary: **Parked project** and
**Parked session** (`docs/context/sessions.md`).

## What people look for

1. Put a whole project out of sight, not one chat at a time.
2. Never lose the conversations.
3. Find it again easily, including by name in search, marked as put away.
4. Bring it back in one step, in the same state.
5. Never have running work killed without a warning.
6. Clean up what the project runs outside the app. Out of scope here; see
   "Later".

Kriyon adds two needs of its own. Parking must actually stop processes, since
the reason to park is to save memory and battery. And picking one session
back up must not clutter the sidebar with the rest.

These changed the design during review and hand-testing: parking moved from a
project flag to each session (opening one brought back dozens), and a
read-only view of a parked session was dropped (Kriyon has no session view
without a terminal).

## Behaviour

### Park

- **Where:** the project header's ⋯ menu, which right-clicking the header
  also opens: **Park project**, Rename, Colour…, Sort sessions…, Close all
  sessions. The header's hover row is new worktree session, new session, ⋯ —
  ⋯ last, on the solid end of the row's fade, so it never sits over the name.
- **Check first:** `projectParkCost` adds up the same Stop cost the quit gate
  reads (`stopCostOfAll`) over the project's sessions on the rail, plus its
  busy terminal panes. If `hasParkCost`, the Confirm dialog names it:
  - Title: "Park acme-web?"
  - Body: e.g. "2 sessions are working and 1 terminal is running a command.
    Parking stops them. Conversations, worktrees and terminal tabs are kept —
    unpark acme-web to pick up where you left off." Background commands are
    listed under it.
  - Buttons: Cancel / **Park and stop**.
  - Nothing busy: no dialog.
- **Then (`parkProjectAndStop`):**
  1. Stamp `parkedAt` on every session still on the rail; save those rows at
     once (not on the persistence debounce), so a crash mid-stop still leaves
     them parked and the orphan sweep finishes the job.
  2. Stop each of them (`disposeSession`) and every terminal pane of the
     project.
  3. If the selection was one of them, it moves to the newest session still
     in sight.
  4. Toast: "Parked acme-web · 5 sessions and 2 terminals stopped".
- **Unchanged:** titles, order, nesting, archived flags, transcripts,
  worktrees, terminal tab layout and names.

### Parked section

- At the bottom of the sidebar, above the Archived group, closed by default:
  **Parked (N)**, N being the projects with a parked session. Hidden at 0.
  Most recently parked first.
- Each project row: colour dot, name, how many sessions Unpark brings back,
  and **Unpark**.
- Expanding it lists its parked sessions the way its rail group would show
  them — same order, "N done" / "N older" folds and nesting — through the
  hook the rail group uses (`useOrderedSessions`). The folds open in place.
- Clicking a session brings back only it (and its leads, if nested) and opens
  it. The rest stay parked.
- Kept apart from the "N inactive projects" fold on purpose: that fold is
  automatic and undoes itself; parking is the person's choice.

### Unpark

- **Unpark** brings every parked session of the project back. Nothing starts:
  each session resumes only when opened.
- Opening a parked session from anywhere — the Parked section, ⌘K, a
  notification — brings back only it and its leads. `setActiveSession` does
  this, so no path can launch a session that stays hidden.
- A new session in the project joins the rail; the parked ones stay parked.
- The project's terminals come back with fresh shells once any of its
  sessions is on the rail again, as at app launch.

### While parked

- Not in: Command center, Needs-you, the project header's attention mark,
  worktree count and age, the quit warning, the nested-session cap. A held
  nested-session request whose lead is parked waits until the lead comes back.
- In: ⌘K, marked "Parked".
- When a project becomes fully parked by any path (*Park project*, or closing
  or archiving its last session on the rail), its terminals stop
  (`installParkedTerminalStops`) and the dock unmounts them.
- The orphan-daemon sweep (`owned_ids`) does not own parked sessions, nor the
  panes of a fully parked project (`fully_parked_projects` in kriyon-core).

## One "put away" check

Archived and parked sessions are both put away: `isPutAway(session)` in the
frontend, `SessionRow::is_put_away()` in Rust. Every surface that skips what
is not live asks it. Selection moves (close, archive, park) go through
`newestSessionId`, which never picks a put-away session.

## Data

- `sessions` gains `parked_at INTEGER` (nullable) through `migrate_column`;
  Rust `SessionRow.parked_at` (`#[serde(default)]`), TS `parkedAt?`. It rides
  on `upsert_session`; there are no new commands.
- A new session's project row is saved as the store holds it, so reopening a
  folder no longer resets the project's colour or setup command.

## Tests

- Store: `parked_at` round-trips; an old store reads `None`.
- Core: `fully_parked_projects` needs every open session parked.
- Orphan sweep: parked sessions and a fully parked project's panes are not
  owned; a partly parked project's panes are.
- Frontend store: park, unpark, open-one-brings-back-only-it, nested leads,
  selection after close/archive/park never lands on a put-away session.
- Actions: what parking stops and saves, the park cost, the saved project row.
- Needs-you, the Command center and the quit cost skip parked sessions.
- Sidebar: the confirm, the Parked section, Unpark, opening one, nesting,
  folds, the header ignoring parked sessions, the ⋯ menu and right-click.
- Terminals: a project's terminals stop when it becomes fully parked; the
  dock unmounts them.

## Later

- **On-park command** per project, beside the setup command, for things Kriyon
  did not start (e.g. `docker compose stop`), with an on-unpark twin.
- A "Park other projects" action for a focus day.
