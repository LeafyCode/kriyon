# Sidebar: Pinned, Folders and Focus — design

**Date:** 2026-11-08
**Status:** Accepted. First version built; see "Built in the first version" at the end.

## Goal

People with many projects want a calmer sidebar: their most important work at the top, the
rest sorted into a few buckets they choose, and a way to see only one bucket while they work.
Someone who never makes a folder or pins anything must see exactly the sidebar they see today.

## What people ask for (research, 2026-11-08)

From public feature requests and forum threads for AI coding tools, chat apps, editors,
browsers and issue trackers:

1. **A fixed order** that does not jump around as sessions get busy. The most common
   complaint about agent sidebars. Kriyon already has drag-to-reorder for projects; this
   design keeps it.
2. **Pin whole projects**, not only chats.
3. **Folders above projects.** People ask for one level, sometimes two, never deeper.
4. **Pin single sessions.** Small caps on pins (around three) draw complaints.
5. **A closed folder still shows when something inside needs you**, and some ask to mute a
   noisy folder.

**Folders, not tags.** Tag-based sidebars show a project once per tag, and research on
personal filing finds tags are rarely kept up. Search covers the cases where a project fits
more than one bucket.

**Empty headers are a known irritant.** People ask to hide empty groups and the "no tags /
uncategorized" header. So: no "Ungrouped" header, and a folder with nothing to show is not
drawn.

**How tools let people make the first folder.** Four patterns recur:

| Pattern | How a folder is made |
| --- | --- |
| Drag onto another item | Hold one item over another, then drop: both go into a new folder. |
| From the item's menu | Right-click an item, "Add to new folder", name it. |
| A button on the section heading | Hover the heading, click the new-folder icon, then drag items in. |
| A "+" menu | "New folder" from a create menu at the foot of the sidebar. |

The pattern that works: start from the item ("put this in a new folder"), so a folder is born
holding something, plus drag for people who prefer it, plus one quiet button.

## Design

### Zero folders, zero pins

The sidebar is unchanged. No Pinned section, no Folders heading, no "Ungrouped" header. The
only new thing is a folder icon beside the sort button on the Projects label, revealed on hover
like sort is today.

### Pinned

- **Pin to top** in the project menu and the session menu. Unpin from the same place.
- A **Pinned** section sits below Needs-you and above Projects. It appears only when something
  is pinned.
- A pinned project shows its whole group there instead of in Projects. A pinned session shows
  there instead of under its project, with its project's name and colour beside it.
- No cap on pins. Pinned items are exempt from the inactive fold (`hideOlderThan`).
- Pinned projects follow the rail's own order (manual, calm or triage) and can be dragged
  like any project. Pinned sessions are listed oldest pin first.

### Folders

- Each project is in **at most one** folder. One level only. Folders are optional.
- Projects in no folder render below the folders, under a thin divider, with no header. With
  no folders at all there is no divider either.
- A folder header shows a chevron, a folder icon, the name and a count of its projects on the
  rail. Collapsed, it also shows the strongest status of anything inside (the same dot a project
  header shows today), so a closed folder never hides work that needs the user.
- A folder whose projects are all off the rail (no open sessions, parked, or folded as
  inactive) is not drawn, matching the rule that only projects with sessions take space. A
  folder no project has joined yet *is* drawn, with a hint on how to fill it, so a folder made
  from the header button does not vanish the moment it is named.
- Collapse state is remembered, like project collapse is today.
- Drag order works inside each folder; folders themselves can be dragged into order. Triage
  mode floats busy projects to the top *within* their folder and floats folders that hold busy
  work above calm ones.

**Making a folder** (three ways, all ending with the name field open in the new header):

1. Project menu › **Move to folder** › **New folder…** — the folder is created holding that
   project. The submenu lists existing folders with a tick on the current one, and **Take out
   of folder**.
2. **Drag** a project and hold it over another project for about half a second: both go into a
   new folder. A quick drag past a project still just reorders. Dropping on a folder adds to
   it; dragging out of a folder takes the project out.
3. The hover-revealed **New folder** icon on the Projects label creates an empty folder at the
   top with its name field open. If it is left empty, it disappears on blur.

**Folder menu:** Focus on this folder, Rename, Delete folder. Deleting never touches the
projects: they go back to the plain list.

### Focus

- **Focus on this folder** (folder menu, or ⌘⇧F on the folder holding the active session)
  hides every other folder and every unfoldered project. A banner under Pinned names the
  folder, with a close button.
- Needs-you still lists everything, marking items outside the focus, so nothing is missed.
- Pinned stays visible: pinning is the person's explicit "always show this".
- Search, while focused, searches the focused folder; the banner offers "Show all".
- Focus is remembered across restarts.

### Interaction with what exists

- **Park** stays the way to put a project away and stop its processes. Folders only sort;
  they stop nothing. A parked project leaves its folder's view and waits in Parked as today; it
  returns to its folder when unparked.
- **Inactive fold** runs inside each folder and on the plain list. Pinned items are exempt.
- **Clear project** removes the project from its folder.
- **Menu bar** grouped mode is unchanged in this round.

## Data and storage

Folders and pins are the person's own organisation, so they live in the Rust store (SQLite),
not in the window `layout` blob that a reset can wipe — the same reasoning as `parked_at`
(ADR 0052). See ADR 0055.

- `projects.pinned_at INTEGER`, `projects.folder_id TEXT` and `sessions.pinned_at INTEGER`,
  added by migration and carried on the whole-row upserts the frontend already sends. No new
  IPC command.
- The folder list is one app-state key, `projectFolders`: a JSON array of `{id, name}`, parsed
  entry by entry. A `folder_id` no folder answers to reads as no folder.
- Folder collapse and the focused folder id stay in `layout` (view state, like
  `collapsedProjectIds`).

## Glossary additions

- **Project folder** — a named, one-level bucket of projects in the sidebar. Sorting only:
  stops nothing. _Avoid_: group (the code already calls one project's block a `ProjectGroup`),
  category, tag, section.
- **Pinned** — a project or session the person keeps at the top of the sidebar. _Avoid_:
  favourite, starred.
- **Folder focus** — the sidebar showing only one Project folder (plus Pinned and Needs-you).

## Out of scope

Tags, nested folders, per-folder mute, ⌘1–9 for pinned items, folders in the menu bar, folder
colours. Revisit after people use v1.

## Build order

1. Pinned (store columns, commands, section, menus).
2. Folders (storage, rendering, three ways to make one, roll-up dot).
3. Focus.

Each step is a test-first, separately reviewable commit on `feat/group-projects`. An ADR records
the storage decision and the folders-not-tags choice.

## Built in the first version

Built: Pinned (projects and sessions); folders from the project menu, the header button and
drag (drop on a folder header to join it; hold over another project for half a second to make
a folder of the two, or to join that project's folder; drop among another section's projects
to move there); rename and delete; the collapsed-folder needs-you dot; Focus with its banner
and ⌘⇧F.

Changed from the design above:

- Folders are ordered by name. Dragging folders into order, and triage floating busy
  folders up, are not built yet.
- While a held hover marks a drop target, the lists stop making room, so the target stays
  under the pointer and is outlined with what dropping will do.
- Pinned projects stay out of folders: pinning takes the project out of its folder
  (unpinning puts it on the plain list), the menu does not offer Move to folder for one, and
  drag does not drop one into a folder.
- Making a folder, from any of the three ways, ends a focus on another folder, so the new
  folder and its name field are on screen.
- A new folder left with an empty name is kept as "New folder", in its place by name. It
  does not vanish on blur or sit at the top.
- There is one inactive fold for the whole rail, not one inside each folder.
- Clear project keeps the project's folder and pin, so it comes back where it was.

Not built yet:

- Needs-you marking items outside the focus.
- Search scoped to the focused folder, and the banner's "Show all".
