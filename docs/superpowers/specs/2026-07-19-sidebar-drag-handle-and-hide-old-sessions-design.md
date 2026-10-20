# Sidebar: drag handle + hide old sessions — design

**Date:** 2026-07-19 · **Branch:** `feat/bug-fixes-4`

Two follow-ups to the sidebar session-sorting arc
(`2026-07-19-sidebar-session-sorting-design.md`), driven by hand-testing the
smoke build:

1. Give drag reordering a **visible grip handle** instead of a whole-row
   activator.
2. Add a **"hide older than …" filter** that folds stale sessions out of each
   project group, à la Claude Desktop's history recency buckets.

Both reuse existing seams; neither introduces a new abstraction.

---

## A. Grip-only drag handle

### Today

`SessionRow` spreads `{...sortableRow.listeners}` and the dnd-kit drag
`attributes` onto the **row div itself** — the whole row is the drag activator.
That forced a careful click-vs-drag disambiguation: selection fires on `click`
(never `pointerdown`) so a press that begins a drag doesn't also resume/launch
the grabbed session, and `sortableRowAria` strips the keyboard-drag ARIA
dnd-kit stamps on every row.

### Change

Move the drag activator to a dedicated **grip**, using dnd-kit's documented
handle pattern:

- The row div keeps `sortableRow.setNodeRef` (the draggable node) but **no
  longer** receives `listeners`/`attributes`.
- A new leading **`GripVertical`** (lucide) element receives
  `sortableRow.setActivatorNodeRef`, `{...sortableRow.listeners}`, and the
  trimmed drag `attributes`. Dragging now starts **only** from the grip.
- The grip sits in a **fixed-width leading slot** present on every row, painted
  only on row hover via the existing `kr-reveal` opacity idiom (the same fade
  the ×/⋯ cluster uses). A fixed slot means the grip appearing on hover causes
  **no layout reflow**. The grip stays visible while its row is being dragged.
- ARIA: the grip is a `button` with `aria-label="Reorder {title}"`. Because a
  real button now carries the drag attributes, the row-level `sortableRowAria`
  stripping shrinks to just the grip (drop the pointer-only-drag keyboard ARIA:
  `aria-describedby`, `aria-pressed`, `aria-disabled`, and the redundant
  `role`/`tabIndex`).

### Consequences

- The row body becomes plain **click-to-select**. The shipped `rowSelectStyle`
  full-bleed overlay button stays exactly as-is; selection still fires on
  `click`. The subtle "select fires on click, not pointerdown, so a drag press
  doesn't activate" constraint is now moot for the row body (drag can't start
  there), but keeping click-select is harmless and preserves the overlay fix
  for the two-click bug.
- The grip is **not rendered** when the row is not sortable: while filtering,
  for folded Done rows, and for rows inside the new "older" fold — so assistive
  tech never sees a reorder affordance that does nothing.
- `data-no-dnd` guards on the actions cluster / menus become redundant (drag no
  longer starts from the row), but are left in place — harmless, and removing
  them is out of scope.

---

## B. Hide old sessions

### Model

A new **global** layout field controls a recency threshold:

```ts
type HideOlderThan = "off" | "6h" | "1d" | "3d" | "1w";
```

- Added to `Layout`, `DEFAULT_LAYOUT` (`"off"`), a `setHideOlderThan` setter on
  the layout store, and persisted through the existing `oneOf` parser combinator
  in `persistence.ts` (defaulting to `"off"` on an unknown/absent value).
- **Global only** — no per-project override. Per-project sort overrides exist
  because sort is a per-project preference; a staleness cutoff is a single
  whole-rail preference. (YAGNI.)

### Age basis

"Last active" = `lastChangeMs` from the command-center store (last observed
status change), falling back to `createdAt`. This field is **low-churn**:
heartbeats update `lastSeenMs`, not `lastChangeMs`, so subscribing a project
group to it does not couple the group to heartbeat frequency.

**Known limitation (accepted):** the command center starts empty each launch, so
until a session's first live status change is observed, its age is measured from
`createdAt`. Fine for a coarse hours/days cutoff.

### Time source

The threshold depends on wall-clock `now`, which advances with no store change —
a session must cross the cutoff as time passes. A **minute-quantized** `now`
(`Math.floor(Date.now() / 60_000) * 60_000`) is threaded into the ordering:

- coarse enough that the `orderMatched` memo cache only busts **once a minute**
  (recomputing a tens-of-sessions group once a minute is negligible), and
- fine enough that a 6-hour cutoff is honoured within a minute.

A single low-frequency ticker in `Sidebar` bumps the quantized value.

### Partition

A new **pure** function, applied to the ordered `rows` in **both** sidebar modes
(after `orderSessions` has sorted/folded):

```ts
partitionOld(
  rows: string[],
  sessions: Record<string, UiSession>,
  lastChangeMs: Record<string, number>,
  activeSessionId: string | null,
  threshold: HideOlderThan,
  now: number,
): { rows: string[]; collapsedOld: string[] }
```

- `threshold === "off"` → everything stays in `rows` (identity).
- A row folds into `collapsedOld` only if it is **past the cutoff** *and* is
  **eligible**. Eligible = status `idle`, or `done`-and-seen.
- **Exempt (never folded), regardless of age:**
  - the active session (`id === activeSessionId`),
  - `running`, `waiting`, `error`,
  - unread `done` (`doneUnseen`).
- Relative order within `rows` and within `collapsedOld` is preserved from the
  incoming `rows` order (no re-sort).

The done-seen fold in triage (`collapsedDone`) is untouched — those rows are
already hidden; `partitionOld` only ever operates on the visible `rows` list.

### UI

- **Control:** the existing **global ↕ popover** (by the filter box) gains a
  divider and a **"Hide older than"** radio section: Off · 6 hours · 1 day ·
  3 days · 1 week. One button, no new header chrome. The per-project ↕ pickers
  stay **sort-only** — `SortMenu` grows an optional hide section that only the
  global caller passes.
- **Fold:** each project group renders a quiet **"⋯ N older — show"**
  disclosure at the bottom (mirrors the existing "N done" summary row),
  expanding to the folded rows. Folded rows render as normal `SessionRow`s with
  `sortable={false}` (no grip).
- **Guard:** hiding is **off while filtering** — a search shows every match,
  same rule as drag. (`filtering` already forces `listMode: "calm"`.)

---

## Files touched

- `src/state/layout.ts` — `HideOlderThan` type, `Layout.hideOlderThan`,
  `DEFAULT_LAYOUT`, `setHideOlderThan`.
- `src/state/persistence.ts` — parse/serialize `hideOlderThan` via `oneOf`.
- `src/sidebar/sessionOrder.ts` — `partitionOld` (+ its eligibility helper).
- `src/sidebar/ProjectGroup.tsx` — thread `hideOlderThan` + quantized `now` +
  `lastChangeMs` + `activeSessionId`; render the "N older" fold.
- `src/sidebar/SessionRow.tsx` — grip element, handle wiring, trimmed ARIA.
- `src/sidebar/SortMenu.tsx` — optional "Hide older than" section.
- `src/sidebar/Sidebar.tsx` — pass the hide section to the global `SortMenu`;
  the minute ticker.
- `src/sidebar/pastSessionTime.ts` — reused (threshold→ms mapping may live here
  or beside `partitionOld`).

## Testing (TDD, failing test first)

- `partitionOld`: each exemption (active, running, waiting, error, unread-done),
  each threshold, the boundary at the cutoff, and `"off"` as identity.
- `hideOlderThan` persistence round-trip + unknown-value default.
- `orderMatched` still memoizes across an unchanged minute-quantized `now`, and
  busts once it advances.
- `SessionRow`: drag activator is the grip only (row-body click selects; a grip
  press does not select); grip absent when `sortable={false}`.

## Out of scope

- Per-project hide overrides.
- Keyboard-driven reordering (still an accepted v1 trade-off from the sorting
  arc).
- Any change to the History / `EarlierSessions` past-transcript list.
