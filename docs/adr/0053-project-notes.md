# ADR 0053 — Project notes: the user's own todos and ideas, kept per project

**Date:** 2026-11-01
**Status:** Accepted

## Context

People working in Kriyon have thoughts that are not prompts: a todo for later,
an idea to try, a fact worth keeping. Today they go to another app, or into a
session's terminal where they get lost or, worse, sent to Claude.

What they asked for:

- A list per **project**, not per session. A session ends; the plan for the
  project outlives it, and every session in the project should see the same list.
- Planning that is theirs alone. Nothing in it goes to Claude.
- Fast capture: a thought should take seconds to write down, from anywhere.

## Decision

- **One list, three kinds.** A [Project note] is a todo, an idea or a plain
  note. One list with a kind beats three panels: a thought can be written down
  before deciding what it is, and changing its kind later is one click. Only a
  todo can be done; turning a done todo into an idea makes it an open idea.
- **Stored in `kriyon.db`**, in a `project_notes` table with a foreign key to
  `projects`, not in the repository. A file in the repo (say
  `.kriyon/notes.md`) would travel with git, but it would also change with
  every branch and worktree switch, show up in diffs and the Changes view, and
  merge-conflict between worktrees of the same project. Notes are personal
  planning, so they stay on this Mac. Sharing them through git can be added
  later as an export.
- **The Rust core checks every note.** `kriyon_core::project_notes::validate`
  bounds the ids, trims and caps the text (500 characters) and body (20,000),
  and drops a done mark on anything but a todo. An update never moves a note
  to another project. The frontend gets back the copy that was stored.
- **Shown in the Details rail, as a Notes tab.** It shows the active session's
  project. The project menu's *Open notes* shows any project's notes without
  opening a session, so a parked project's notes can be read without bringing
  it back. A sidebar item was considered; the rail already sits beside the
  work, and a third sidebar section would push sessions down.
- **Capture from anywhere with ⌘⇧N** (and *Add a note…* in ⌘K). The chord is
  reserved, so a focused terminal passes it to the app.
- **Only open todos are counted** — on the Notes tab and the project header.
  Ideas and notes never show a count: they are not work waiting to be done.
- **A failed save is never silent.** The store shows a change at once, then
  saves it; if the save fails, the change is rolled back and a toast says so.
  A failed load at launch says so too, because an empty list would read as
  "your notes are gone".

## Consequences

- Notes stay when a project is parked or its sessions are closed. Projects are
  never deleted from the store today, so notes have no orphan case yet; when
  project deletion arrives, it must delete or offer to keep the project's notes.
- Notes are plaintext in `kriyon.db`, protected by file modes and FileVault —
  the same stance as the rest of the store.
- Not now: due dates, reminders, tags, reordering by drag, and sending a note
  to Claude. Each is easy to add on this table if people ask.
