# Sidebar session sorting — design

**Date:** 2026-07-19
**Status:** Approved (brainstormed with the maintainer)

## Goal

Let the user control the order of sessions inside each sidebar project group:
drag rows to a manual order that is remembered, or pick date / name sorting —
globally, with an optional per-project override.

## Sort model

New type in `src/state/layout.ts`:

```ts
export type SessionSort = "manual" | "date" | "name";
```

Three new persisted fields on `Layout`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `sessionSort` | `SessionSort` | `"date"` | Global sort for every project group. |
| `projectSortOverrides` | `Record<string, SessionSort>` | `{}` | Per-project override; absent = follow global. |
| `manualSessionOrder` | `Record<string, string[]>` | `{}` | Per-project session-id order used by `manual`. |

Store actions:

- `setSessionSort(mode)` — sets the global mode **and clears
  `projectSortOverrides`** (changing the global resets every per-project
  choice; manual orders are kept — they are positions, not a mode).
- `setProjectSort(projectId, mode | null)` — sets or clears (`null` =
  follow global) one project's override.
- `setManualSessionOrder(projectId, orderedIds)` — writes the full manual
  order list for that project (see Drag). The list passed in is already
  pruned of ids that no longer exist.

The effective sort for a project is
`projectSortOverrides[projectId] ?? sessionSort`.

All three fields persist inside the existing `saveLayout` blob
(`src/state/persistence.ts`) with validating parsers: unknown mode strings
fall back to defaults, non-string-array orders are dropped.

## Ordering semantics

All ordering stays in `src/sidebar/sessionOrder.ts` as pure functions.
`orderSessions` gains the effective sort and the project's manual list as
inputs; `orderMatched`'s cache key/guards grow to cover them.

- **date** — newest-first (`createdAt` desc; unchanged behavior). This is the
  neutral default: in triage mode, today's status-rank floating and read-done
  folding still apply exactly as now.
- **name** — alphabetical by session title (`localeCompare`). The sort fully
  wins: no status floating, even in triage. Triage still folds read Done rows
  into the "N done" summary (folding is collapsing, not ordering).
- **manual** — follow `manualSessionOrder[projectId]`. Sessions not in the
  list (newly spawned since the last drag) go on top, newest-first, above the
  arranged block. Ids in the list with no matching open session are ignored.
  Sort fully wins; triage keeps only its done-folding.

Filtering behavior is unchanged: a filtered list keeps showing every match
(no done fold), ordered by the effective sort.

## Drag to reorder

- Implemented with **dnd-kit** (`@dnd-kit/core` + `@dnd-kit/sortable`) —
  pointer-event based (avoids WKWebView's flaky HTML5 drag-and-drop),
  auto-scrolls the rail during a drag. Accepted as a new dependency.
  **Pointer-only in v1** — there is no keyboard path to manual reordering
  (dnd-kit's keyboard role/tabIndex plumbing is deliberately stripped so rows
  aren't dead tab stops); a keyboard affordance (move up/down in the row's ⋯
  menu, or a KeyboardSensor) is explicitly future work.
- Rows are sortable **within their project group only**; no cross-project
  drag (a session belongs to its project's path). The visible order is
  frozen for the duration of a drag: live status flips must not re-sort the
  list under the pointer.
- On drop: the pure helper
  `dropOrder(prev, rows, collapsedDone, activeId, overId)` merges the drop
  into the previously saved order — an id saved earlier but not visible now
  (archived, or Done folded away in triage) keeps its slot next to its old
  neighbor; never-placed folded Done ids are appended — and
  `commitSessionDrop` writes it via `setManualSessionOrder(projectId, next)`.
  That action also pins `projectSortOverrides[projectId] = "manual"` when the
  project's effective sort isn't already `manual`, so the drop sticks
  regardless of the global mode; the pin fires a toast, since silently
  flipping a triage list into manual order would otherwise be invisible.
- Selection fires on click only, never on pointer-down: a press that begins a
  drag must not activate (and thereby resume/launch) the grabbed session.
- Sort state self-heals: on hydrate, `pruneSortState` drops entries for
  projects and sessions that no longer exist, so the layout blob cannot
  accrete dead ids forever.
- The whole row is the drag handle; the existing click-to-select stays (drag
  starts only after the pointer moves past dnd-kit's activation distance).
- Dragging is disabled while a filter query is active: the visible rows are a
  subset, so a drop there would silently rewrite the manual order without the
  hidden sessions.

## UI

- **Global picker:** a sort button (↕ `ArrowUpDown` icon) beside the filter
  box opens an anchored radio menu — Manual / Date / Name — bound to
  `sessionSort` (reuses `AnchoredMenu`).
- **Per-project override:** a fourth hover-revealed button on each project
  header opens the same menu plus a "Follow global" item. A header with an
  active override keeps its icon faintly visible when not hovered, so a
  pinned project is recognizable.

## Testing

TDD throughout:

- `sessionOrder` units: manual order with new/missing ids; name sort; date
  sort; triage × each sort (floating only under date; done-fold always);
  filter forcing full rows.
- Layout store: `setSessionSort` resets overrides; `setProjectSort` set and
  clear; `setManualSessionOrder` writes the manual list and pins the project
  to manual (stale ids aren't deleted from storage — they're just skipped
  when computing order, see Ordering semantics above).
- Persistence: parse round-trip, malformed values fall back to defaults.
- Component: a simulated drop calls `dropOrder` to compute the new order and
  `setManualSessionOrder` with the right ids, flipping the project to
  manual.
- Visual drag feel verified in the browser (Playwright + `window.__kriyon`
  seam) after implementation.

## Out of scope

- Dragging sessions between projects.
- Sorting project groups themselves (still alphabetical / triage urgency).
- Sorting History (past sessions) lists.
