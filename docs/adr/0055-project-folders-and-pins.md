# ADR 0055 — Project folders and pins: one-level folders, no tags, stored with the projects

**Date:** 2026-11-08
**Status:** Accepted

## Context

People with many projects want a calmer sidebar: their most important work at
the top, the rest in a few buckets they choose, and a way to see only one
bucket at a time. Research across Claude Code Desktop, Cursor, ChatGPT, Codex,
Slack, Discord, Linear, Arc and VS Code Project Manager (see the design spec,
`docs/superpowers/specs/2026-11-08-sidebar-pinned-folders-focus-design.md`)
found the same requests: pin whole projects and single sessions, group
projects into folders one level deep, and keep a closed folder showing when
something inside needs the person. It also found two common complaints: tag
sidebars that list one project once per tag, and empty "Uncategorized" or
empty-group headers nobody can hide.

Kriyon already has a manual project order, an inactive fold and Park. None of
them lets the person sort projects into named groups.

## Decision

- **Folders, not tags.** A project is in at most one [Project folder], one
  level deep. Tags would repeat a project in several places and need upkeep
  people rarely give. Search covers projects that fit more than one bucket.
- **Nothing changes for someone who never uses them.** With no folder and no
  pin, the sidebar is exactly what it was: no Pinned section, no folder
  heading, no "Ungrouped" header. Projects in no folder sit below the folders
  under a plain line.
- **Pins and folder membership are columns on the existing rows.**
  `projects.pinned_at`, `projects.folder_id` and `sessions.pinned_at` ride the
  same whole-row upserts the frontend already sends, so no new IPC command is
  needed. They are the person's own organisation, so they live in SQLite, not
  in the window layout blob a reset can wipe — the same reasoning as
  `parked_at` (ADR 0052).
- **The folder list is its own app-state key** (`projectFolders`), a JSON
  array of `{id, name}`, parsed entry by entry so one bad record never loses
  the rest. A `folder_id` that no folder answers to reads as no folder, so a
  deleted folder can never strand a project.
- **View state stays in the layout:** which folders are collapsed and which
  one is focused, next to the existing project collapse and manual order.
- **Pins are display only.** A pinned session runs exactly as before. A
  parked or archived pin waits where put-away sessions wait and comes back to
  Pinned with them.

## Consequences

- One pure function (`railSections`) decides what each section shows, so the
  sidebar only draws its result.
- Folder order is by name in this first version. Dragging a project onto
  another to make a folder, and dragging folders into order, are left for a
  later change; the project menu and the header button cover making folders.
