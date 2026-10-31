# Park a project — design

**Date:** 2026-10-31 · **Branch:** `feat/park-project` · **Decision:** [ADR-0052](../../adr/0052-park-a-project.md)

## Goal

Let a person put away a project they are not working on today: stop every
session and project terminal in it, take it out of the sidebar, and bring it
back as it was in one step. The glossary term is **Parked project**
(`docs/context/sessions.md`).

## What people look for

From similar tools (T3 Code discussion #16166, a Claude Code desktop request to
hide sidebar projects, Conductor's archive and History pane, and a Claude
Desktop bug where auto-archive killed running work):

1. Put a whole project out of sight, not one chat at a time.
2. Never lose the conversations.
3. Find it again easily, including by name in search, marked as put away.
4. Read old conversations without restoring the project.
5. Bring it back in one step, in the same state.
6. Never have running work killed without a warning.
7. Clean up what the project runs outside the app (Conductor's archive
   script). Out of scope here; see "Later".

Kriyon adds one need of its own: parking must actually stop processes, because
the reason to park is to save memory and battery.

## Behaviour

### Park

- **Where:** project menu (⋯ on the project header): Rename, **Park project**,
  Clear project.
- **Check first:** collect the Stop cost (`stopCostFor`) of every non-archived
  session in the project, and `isTabBusy` for every terminal tab the project
  owns. If anything has a cost, show the Confirm dialog:
  - Title: "Park Thinkar?"
  - Body: names what will stop, e.g. "2 sessions are working and 1 terminal is
    running `pnpm dev`. Parking stops them."
  - Buttons: Cancel / **Park**.
  - Nothing busy: no dialog.
  - The dialog snapshots the session ids, like Clear project.
- **Then:**
  1. Set `parkedAt` on the project (store write first, so a crash mid-stop
     still leaves it parked and the orphan sweep finishes the job).
  2. `disposeSession` every non-archived session in the project and every
     terminal pane in `useTerminals.byProject[projectId]`. Fire-and-forget,
     like `archiveSessionAndStop`.
  3. If the active session was in the project, select the next session on the
     rail (same rule as archive), or the welcome screen.
  4. Toast: "Parked Thinkar · 5 sessions and 2 terminals stopped · Undo".
     Undo unparks; it does not restart anything.
- **Unchanged:** session rows, titles, order, nesting, archived flags,
  transcripts, worktrees, terminal tab layout and names.

### Parked section

- At the bottom of the sidebar, above the Archived group, closed by default:
  **Parked (N)**. Hidden when N is 0.
- Each row: project colour dot, name, "5 sessions", and an **Unpark** button
  shown on hover and focus (always shown for keyboard users).
- Clicking the row expands it to show its session titles, read-only and dimmed.
  Clicking a session opens it **read-only** (Transcript / Changes views, no
  terminal, a banner "This project is parked · Unpark to continue"). This
  covers need 4 without restarting anything.
- Order: most recently parked first.
- Parked projects are never part of the "N inactive projects" fold. That fold
  is automatic and comes back on its own; parking is the person's choice and
  only they undo it. Keeping them apart keeps each rule visible.

### Unpark

- **Unpark** button, the read-only banner's button, the toast's Undo, or
  starting a new session in the project (New session in this folder, opening
  the folder, a past session resume). Each clears `parkedAt`.
- The group returns to its usual place on the rail with its sessions in the
  same order. Each session shows as stopped and resumes with
  `claude --resume` only when opened (the existing reopen path after archive).
  Terminal panes open a fresh shell when shown. Nothing starts by itself.

### While parked

- Not in: Command center, Needs-you rail, notifications, auto-sleep, quit
  confirm's Stop cost, Session resources totals.
- In: History and search, with a "Parked" tag, so typing the name finds it.
- A nested-session request that targets a parked project's session is refused
  with "That project is parked".
- The orphan-daemon sweep (`owned_ids`) treats a parked project's sessions and
  terminal panes as not owned, so anything that survived the stop is reaped.
- Clear project on a parked project: allowed from the Parked row's menu; it
  closes the sessions as today and drops the project from the Parked section.

## Root-cause guard: one "put away" check

Today "skip archived sessions" is written out separately in `commandCenter.ts`,
`needsYouItems.ts`, `stopCost.ts`, `sessions.ts` and `daemon_rt.rs`. Adding
"or parked" to each copy is the second-path bug AGENTS.md warns about. Instead:

- Frontend: one selector `isPutAway(session, parkedProjectIds)` in
  `src/state/sessions.ts`, true for archived sessions and for sessions of a
  parked project. Every current `archivedAt !== null` filter that means "not
  live" moves to it. The Archived group itself still reads `archivedAt`.
- Rust: `owned_ids` filters on one `SessionRow::is_put_away(&parked)` helper.

## Data

- Rust `ProjectRow` gains `parked_at: Option<i64>`; `projects` gains
  `parked_at INTEGER` through `migrate_column`. `upsert_project` writes it.
- TS `ProjectRow` gains `parkedAt: number | null`.
- New commands: `park_project(project_id)` and `unpark_project(project_id)`,
  each validating that the id exists and returning `Result`. Both go through
  `src/ipc/bridge.ts`. The frontend does the stopping (it already owns
  `disposeSession`), the Rust side owns the flag and the sweep.

## Files

| Area | File |
|---|---|
| Store, migration, helper | `src-tauri/src/store.rs`, `store_cmd.rs` |
| Orphan sweep | `src-tauri/src/daemon_rt.rs` (`owned_ids`) |
| Bridge | `src/ipc/bridge.ts`, `src/types.ts` |
| Park / unpark actions | `src/state/actions.ts` (`parkProject`, `unparkProject`, beside `archiveSessionAndStop`) |
| Put-away check | `src/state/sessions.ts` + callers in `commandCenter.ts`, `needsYouItems.ts`, `stopCost.ts` |
| Menu | `src/sidebar/ProjectMenu.tsx` |
| Confirm | `src/sidebar/ParkProjectConfirm.tsx` (adapter of `ConfirmDialog`) |
| Parked section | `src/sidebar/ParkedGroup.tsx`, `Sidebar.tsx`, `sessionOrder.ts` (keep parked out of `inactiveProjectIds`) |
| Read-only open | the session view banner + skip `launchActiveSession` for a put-away session |
| Docs | `docs/context/sessions.md`, `docs/context/ui.md`, `FEATURES.md` |

## Tests (write first)

- Store: `parked_at` round-trips; an old store without the column reads `None`.
- `owned_ids`: parked project's session and pane ids are not owned.
- `isPutAway`: archived → true, parked project → true, otherwise false.
- Command center, Needs-you and total Stop cost skip parked sessions.
- `inactiveProjectIds` never returns a parked project.
- Park with nothing busy: no dialog, every session and pane disposed, flag set,
  toast shown.
- Park with a busy session: dialog names it; Cancel changes nothing.
- A session created while the dialog is open is not stopped.
- Unpark: group back in the same order, no session or pane started until opened.
- New session in a parked project unparks it.
- Opening a parked session is read-only and starts no process.

## Later

- **On-park command** per project, beside the setup command, for things Kriyon
  did not start (e.g. `docker compose stop`), with an on-unpark twin.
- A "Park other projects" action for a focus day.
