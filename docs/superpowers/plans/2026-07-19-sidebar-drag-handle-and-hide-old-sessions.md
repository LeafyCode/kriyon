# Sidebar drag handle + hide old sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-row drag with a hover grip handle, and add a global "hide sessions older than …" filter that folds stale idle/done-seen rows out of each project group.

**Architecture:** Feature A moves dnd-kit's drag activator off the row div onto a dedicated `GripVertical` handle (dnd-kit `setActivatorNodeRef` pattern). Feature B adds a `hideOlderThan` global layout field, a pure `partitionOld` step folded into the existing memoized `orderMatched` (so it inherits the group's render-isolation), and a "N older — show" disclosure mirroring the existing "N done" fold.

**Tech Stack:** React + TypeScript, Zustand stores (`layout`, `sessions`, `commandCenter`), `@dnd-kit/sortable`, Vitest + `@testing-library/react`, lucide-react icons.

## Global Constraints

- Frontend is UI-only: no process/fs/network; state via stores, persisted through `src/state/persistence.ts`. (AGENTS.md)
- Design values come from `src/theme/tokens.ts` — never hardcode colors/spacing. (AGENTS.md)
- Formatting + JS/TS lint owned by Ultracite/Biome — run `pnpm fix`, never hand-format. (CLAUDE.md)
- `pnpm check` must pass before every commit. (AGENTS.md)
- Shared working tree: **stage named files only** — never `git add -u/-A/.`. (other sessions may share the checkout)
- Conventional commits, small and frequent; branch is `feat/bug-fixes-4` (already typed — do not commit to `main`).
- Threshold values are exactly: `off`, `6h`, `1d`, `3d`, `1w`. Control labels: `Off`, `6 hours`, `1 day`, `3 days`, `1 week`.
- No new test framework — Vitest + Testing Library, matching existing sidebar tests.

---

### Task 1: Grip-only drag handle on `SessionRow`

Move the drag activator from the row div to a hover-revealed `GripVertical` handle. Independent of Feature B.

**Files:**
- Modify: `src/sidebar/SessionRow.tsx`
- Test: `src/sidebar/Sidebar.test.tsx` (SessionRow is already imported there)

**Interfaces:**
- Consumes: `useSortable` (already used) — additionally `sortableRow.setActivatorNodeRef`.
- Produces: a row-scoped drag handle `data-testid="drag-handle-{sessionId}"`, `aria-label="Reorder {title}"`. Row body still selects on click via the existing `rowSelectStyle` overlay.

- [ ] **Step 1: Write the failing tests**

Add to `src/sidebar/Sidebar.test.tsx` (near the other SessionRow-focused tests). These wrap the row in a `DndContext`/`SortableContext` because `useSortable` requires a sortable ancestor:

```tsx
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { UiSession } from "../state/sessions.ts";

function seedSession(id: string, over: Partial<UiSession> = {}): void {
  const session: UiSession = {
    archivedAt: null,
    claudeSessionId: null,
    createdAt: 1000,
    cwd: "",
    id,
    projectId: "p",
    status: "idle",
    summary: "",
    title: id,
    worktreePath: null,
    ...over,
  };
  useSessions.setState({ sessions: { [id]: session } });
}

function renderRow(id: string, sortable: boolean, onSelect = vi.fn()) {
  render(
    <DndContext>
      <SortableContext items={[id]}>
        <SessionRow
          mode="calm"
          onCloseSession={vi.fn()}
          onSelect={onSelect}
          sessionId={id}
          sortable={sortable}
        />
      </SortableContext>
    </DndContext>
  );
  return onSelect;
}

test("a sortable row shows a drag handle; clicking the body still selects", () => {
  seedSession("s1", { title: "Fix login" });
  const onSelect = renderRow("s1", true);
  expect(screen.getByTestId("drag-handle-s1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open Fix login" }));
  expect(onSelect).toHaveBeenCalledWith("s1");
});

test("a non-sortable row renders no drag handle", () => {
  seedSession("s2", { title: "Old one" });
  renderRow("s2", false);
  expect(screen.queryByTestId("drag-handle-s2")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx -t "drag handle"`
Expected: FAIL — no element with `data-testid="drag-handle-s1"`.

- [ ] **Step 3: Implement the grip handle**

In `src/sidebar/SessionRow.tsx`:

1. Add `GripVertical` to the lucide import:
```tsx
import { Check, GitBranch, GripVertical, X } from "lucide-react";
```

2. Replace the `sortableRowAria` helper (the big-comment function at lines ~61-77) with a grip-scoped attribute filter — the handle is a real focusable control, so only the keyboard-drag `aria-describedby` (a "press space to pick up" pointer we don't honour) is dropped:
```tsx
/**
 * dnd-kit's `attributes` include `aria-describedby`, which points at its
 * "press space to pick up" keyboard-drag instructions — untrue here (pointer
 * sensor only, no keyboard drag). Drop just that; keep role/tabIndex/
 * aria-roledescription so the grip reads as a sortable control.
 */
function gripAttributes(
  attributes: ReturnType<typeof useSortable>["attributes"]
): Record<string, unknown> {
  const { "aria-describedby": _describedBy, ...rest } = attributes;
  return rest;
}
```

3. Add the handle style (uses tokens; fixed 14px slot so the grip appearing on hover never reflows the row):
```tsx
/**
 * Leading drag-grip slot: a fixed-width column present on every row so the
 * grip fading in on hover never shifts the title. `kr-reveal-cluster` fades it
 * with the row's hover; while dragging we force it visible. `pointerEvents:auto`
 * re-enables input inside the click-through row content so the grip — not the
 * select overlay beneath it — receives the drag press.
 */
function dragHandleStyle(dragging: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.ghost,
    cursor: "grab",
    display: "flex",
    flex: "none",
    justifyContent: "center",
    opacity: dragging ? 1 : undefined,
    pointerEvents: "auto",
    width: "14px",
  };
}
```

4. On the row `<div>` (lines ~422-433), **remove** `{...sortableRowAria(sortable, sortableRow.attributes)}` and `{...sortableRow.listeners}`. The div keeps `ref={setRowRef}`, `tabIndex={-1}`, `className`, `data-*`, and `style`.

5. As the **first child** of the `rowContentStyle` div (line ~441), add the grip slot:
```tsx
<div style={rowContentStyle}>
  {sortable ? (
    <span
      aria-label={`Reorder ${session.title}`}
      className="kr-reveal-cluster"
      data-no-dnd="false"
      data-testid={`drag-handle-${sessionId}`}
      ref={sortableRow.setActivatorNodeRef}
      style={dragHandleStyle(sortableRow.isDragging)}
      {...gripAttributes(sortableRow.attributes)}
      {...sortableRow.listeners}
    >
      <GripVertical size={12} />
    </span>
  ) : (
    <span style={{ flex: "none", width: "14px" }} />
  )}
  <SidebarStatusGlyph
    ...unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx -t "drag handle"`
Expected: PASS (both).

- [ ] **Step 5: Full check + commit**

Run: `pnpm fix && pnpm check`
Expected: green.
```bash
git add src/sidebar/SessionRow.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): move session drag to a hover grip handle"
```

---

### Task 2: `hideOlderThan` layout field + setter

**Files:**
- Modify: `src/state/layout.ts`
- Test: `src/state/layout.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces:
  - `type HideOlderThan = "off" | "6h" | "1d" | "3d" | "1w"`
  - `Layout.hideOlderThan: HideOlderThan`
  - `useLayout` action `setHideOlderThan: (value: HideOlderThan) => void`
  - `DEFAULT_LAYOUT.hideOlderThan === "off"`

- [ ] **Step 1: Write the failing test**

Append to `src/state/layout.test.ts` (create with this header if it does not exist):
```ts
import { beforeEach, expect, test } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
});

test("hideOlderThan defaults to off and setHideOlderThan updates it", () => {
  expect(useLayout.getState().layout.hideOlderThan).toBe("off");
  useLayout.getState().setHideOlderThan("1d");
  expect(useLayout.getState().layout.hideOlderThan).toBe("1d");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/state/layout.test.ts -t "hideOlderThan"`
Expected: FAIL — `hideOlderThan` is not a property / `setHideOlderThan` is not a function.

- [ ] **Step 3: Implement**

In `src/state/layout.ts`:

1. Add the type near `SessionSort` (line ~17):
```ts
/** How aggressively the sidebar folds away stale sessions. `off` hides none. */
export type HideOlderThan = "off" | "6h" | "1d" | "3d" | "1w";
```

2. Add to the `Layout` interface (keep alphabetical-ish with neighbours):
```ts
  /** Fold sessions whose last activity predates this cutoff into a per-group
   *  "N older" disclosure; `off` shows all. */
  hideOlderThan: HideOlderThan;
```

3. Add to `DEFAULT_LAYOUT`:
```ts
  hideOlderThan: "off",
```

4. Add the setter to `LayoutState` and the store:
```ts
  setHideOlderThan: (value: HideOlderThan) => void;
```
```ts
  setHideOlderThan: (hideOlderThan) =>
    set((state) => ({ layout: { ...state.layout, hideOlderThan } })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/state/layout.test.ts -t "hideOlderThan"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/layout.ts src/state/layout.test.ts
git commit -m "feat(layout): add hideOlderThan session-staleness field"
```

---

### Task 3: Persist `hideOlderThan`

**Files:**
- Modify: `src/state/persistence.ts`
- Test: `src/state/persistence.test.ts` (append)

**Interfaces:**
- Consumes: `HideOlderThan`, `Layout` (Task 2). The serialize path is `JSON.stringify(layout)` — the new field is included automatically once it is on `Layout`; only the parse path needs a validator.
- Produces: `parseLayout` round-trips `hideOlderThan`; unknown/absent values fall back to `"off"`.

- [ ] **Step 1: Write the failing test**

Append to `src/state/persistence.test.ts`:
```ts
test("parseLayout round-trips hideOlderThan and defaults unknown values to off", () => {
  const withValue = parseLayout(JSON.stringify({ hideOlderThan: "3d" }));
  expect(withValue?.hideOlderThan).toBe("3d");

  const bogus = parseLayout(JSON.stringify({ hideOlderThan: "17y" }));
  expect(bogus?.hideOlderThan).toBe("off");

  const absent = parseLayout(JSON.stringify({}));
  expect(absent?.hideOlderThan).toBe("off");
});
```
(If `parseLayout` is not yet imported in that test file, add it to the existing import from `./persistence.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/state/persistence.test.ts -t "hideOlderThan"`
Expected: FAIL — `hideOlderThan` is `undefined` on the parsed layout.

- [ ] **Step 3: Implement**

In `src/state/persistence.ts`:

1. Add `HideOlderThan` to the type import from `../state/layout.ts` (the import block near the top that already brings in `SessionSort`, `Layout`).

2. Add an exhaustive set + parser beside `parseSessionSort` (line ~128), mirroring the `SESSION_SORT_SET` pattern so a new member is a compile error if unlisted:
```ts
const HIDE_OLDER_SET: Record<HideOlderThan, true> = {
  "1d": true,
  "1w": true,
  "3d": true,
  "6h": true,
  off: true,
};
const HIDE_OLDER_VALUES = Object.keys(HIDE_OLDER_SET) as readonly HideOlderThan[];
const parseHideOlderThan = oneOf<HideOlderThan>(HIDE_OLDER_VALUES, "off");
```

3. Add one line to the object `parseLayout` returns (line ~207, alongside the other fields):
```ts
    hideOlderThan: parseHideOlderThan(parsed.hideOlderThan),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/state/persistence.test.ts -t "hideOlderThan"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat(persistence): persist hideOlderThan across restart"
```

---

### Task 4: `partitionOld` pure function

The staleness fold, as a standalone tested unit. Not yet wired into rendering.

**Files:**
- Modify: `src/sidebar/sessionOrder.ts`
- Test: `src/sidebar/sessionOrder.test.ts` (append)

**Interfaces:**
- Consumes: `UiSession`, `HideOlderThan`, `EMPTY_ORDER`.
- Produces:
```ts
export interface PartitionedRows { rows: string[]; collapsedOld: string[] }
export function partitionOld(
  rows: string[],
  sessions: Record<string, UiSession>,
  lastChangeMs: Record<string, number>,
  unseen: (id: string) => number,
  activeSessionId: string | null,
  threshold: HideOlderThan,
  now: number,
): PartitionedRows
```
Eligible to fold = not the active session, and status `idle` **or** (`done` with `unseen === 0`); age = `lastChangeMs[id] ?? session.createdAt`; folds when `age < now - cutoff`. Running/waiting/error and unread-done are never eligible.

- [ ] **Step 1: Write the failing tests**

Append to `src/sidebar/sessionOrder.test.ts` (reuse its `session()` helper and add `partitionOld`, `type PartitionedRows` to the import from `./sessionOrder.ts`):
```ts
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;

function sessionsMap(list: UiSession[]): Record<string, UiSession> {
  return Object.fromEntries(list.map((s) => [s.id, s]));
}

test("partitionOld with off is identity", () => {
  const s = sessionsMap([session("a", "idle", 0)]);
  const out = partitionOld(["a"], s, {}, () => 0, null, "off", NOW);
  expect(out.rows).toEqual(["a"]);
  expect(out.collapsedOld).toEqual([]);
});

test("partitionOld folds an idle session past the cutoff", () => {
  const s = sessionsMap([session("a", "idle", NOW - 2 * DAY)]);
  const out = partitionOld(["a"], s, {}, () => 0, null, "1d", NOW);
  expect(out.collapsedOld).toEqual(["a"]);
  expect(out.rows).toEqual([]);
});

test("partitionOld keeps a recent idle session", () => {
  const s = sessionsMap([session("a", "idle", NOW - 2 * HOUR)]);
  const out = partitionOld(["a"], s, {}, () => 0, null, "6h", NOW);
  expect(out.rows).toEqual(["a"]);
  expect(out.collapsedOld).toEqual([]);
});

test("partitionOld exempts active, running, waiting, error, and unread-done", () => {
  const old = NOW - 30 * DAY;
  const s = sessionsMap([
    session("active", "idle", old),
    session("run", "running", old),
    session("wait", "waiting", old),
    session("err", "error", old),
    session("unread", "done", old),
    session("seen", "done", old),
  ]);
  const rows = ["active", "run", "wait", "err", "unread", "seen"];
  const unseen = (id: string) => (id === "unread" ? 3 : 0);
  const out = partitionOld(rows, s, {}, unseen, "active", "1w", NOW);
  expect(out.collapsedOld).toEqual(["seen"]);
  expect(out.rows).toEqual(["active", "run", "wait", "err", "unread"]);
});

test("partitionOld prefers lastChangeMs over createdAt for age", () => {
  // Created long ago, but a status change 1h ago keeps it recent under a 1d cut.
  const s = sessionsMap([session("a", "idle", NOW - 30 * DAY)]);
  const out = partitionOld(["a"], s, { a: NOW - HOUR }, () => 0, null, "1d", NOW);
  expect(out.rows).toEqual(["a"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sidebar/sessionOrder.test.ts -t "partitionOld"`
Expected: FAIL — `partitionOld` is not exported.

- [ ] **Step 3: Implement**

In `src/sidebar/sessionOrder.ts`:

1. Extend the layout import (line 1):
```ts
import type { HideOlderThan, SessionSort, SidebarMode } from "../state/layout.ts";
```

2. Add near the top (after the imports / before `sessionRank`):
```ts
const HIDE_HOUR_MS = 3_600_000;
const HIDE_DAY_MS = 24 * HIDE_HOUR_MS;

/** Milliseconds a session may sit stale before a threshold folds it away. */
const HIDE_THRESHOLD_MS: Record<Exclude<HideOlderThan, "off">, number> = {
  "1d": HIDE_DAY_MS,
  "1w": 7 * HIDE_DAY_MS,
  "3d": 3 * HIDE_DAY_MS,
  "6h": 6 * HIDE_HOUR_MS,
};
```

3. Add the function (place it just above `computeMatched`, which will call it in Task 5):
```ts
/** A row list split into the rows still shown and the stale ids folded away. */
export interface PartitionedRows {
  collapsedOld: string[];
  rows: string[];
}

/**
 * Fold stale sessions out of an ordered row list. A row folds only when it is
 * neither the active session nor live/awaited work: idle, or a finished row the
 * user has already seen, whose last activity ({@link lastChangeMs}, falling back
 * to `createdAt`) predates the threshold's cutoff from `now`. `off` folds
 * nothing (identity). Running/waiting/error and unread-done are always kept —
 * age never buries live or unseen work. Order within each side is preserved.
 */
export function partitionOld(
  rows: string[],
  sessions: Record<string, UiSession>,
  lastChangeMs: Record<string, number>,
  unseen: (id: string) => number,
  activeSessionId: string | null,
  threshold: HideOlderThan,
  now: number
): PartitionedRows {
  if (threshold === "off") {
    return { collapsedOld: EMPTY_ORDER, rows };
  }
  const cutoff = now - HIDE_THRESHOLD_MS[threshold];
  const kept: string[] = [];
  const old: string[] = [];
  for (const id of rows) {
    const session = sessions[id];
    const eligible =
      session !== undefined &&
      id !== activeSessionId &&
      (session.status === "idle" ||
        (session.status === "done" && unseen(id) === 0));
    const lastActive = lastChangeMs[id] ?? session?.createdAt ?? now;
    if (eligible && lastActive < cutoff) {
      old.push(id);
    } else {
      kept.push(id);
    }
  }
  return { collapsedOld: old, rows: kept };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/sidebar/sessionOrder.test.ts -t "partitionOld"`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/sessionOrder.ts src/sidebar/sessionOrder.test.ts
git commit -m "feat(sidebar): partitionOld staleness fold (pure)"
```

---

### Task 5: Fold `partitionOld` into `orderMatched` + render the "N older" disclosure

Wire hiding into the group so it inherits the memoized render-isolation, and show the fold.

**Files:**
- Modify: `src/sidebar/sessionOrder.ts` (extend `OrderedSessions`, `orderMatched`, `computeMatched`)
- Modify: `src/sidebar/ProjectGroup.tsx` (pass hide inputs, render the fold)
- Modify: `src/sidebar/Sidebar.tsx` (minute ticker + `nowMinute` prop)
- Test: `src/sidebar/sessionOrder.test.ts` (append), `src/sidebar/Sidebar.test.tsx` (append)

**Interfaces:**
- Consumes: `partitionOld`, `PartitionedRows` (Task 4); `useCommandCenter().lastChangeMs`; `Layout.hideOlderThan`.
- Produces:
  - `OrderedSessions` gains `collapsedOld: string[]`.
  - `orderMatched`/`computeMatched` gain a trailing `hide: HideInputs` param:
    ```ts
    export interface HideInputs {
      activeSessionId: string | null;
      lastChangeMs: Record<string, number>;
      now: number;
      threshold: HideOlderThan;
    }
    ```
  - `ProjectGroup` accepts a `nowMinute: number` prop (0 when hiding is off).

- [ ] **Step 1: Write the failing tests**

Append to `src/sidebar/sessionOrder.test.ts` (add `HideInputs` to the import):
```ts
const OFF_HIDE = {
  activeSessionId: null,
  lastChangeMs: {},
  now: NOW,
  threshold: "off" as const,
};

test("orderMatched folds stale idle rows into collapsedOld", () => {
  const p = project("p", "Proj");
  const input: OrderInputs = {
    appendSeq: {},
    sessions: {
      fresh: session("fresh", "idle", NOW - HOUR, "p"),
      stale: session("stale", "idle", NOW - 5 * DAY, "p"),
    },
    viewed: {},
  };
  const out = orderMatched(input, p, "", false, "calm", "date", EMPTY_ORDER, {
    activeSessionId: null,
    lastChangeMs: {},
    now: NOW,
    threshold: "1d",
  });
  expect(out.collapsedOld).toEqual(["stale"]);
  expect(out.rows).toEqual(["fresh"]);
});

test("orderMatched with off leaves collapsedOld empty", () => {
  const p = project("p", "Proj");
  const input: OrderInputs = {
    appendSeq: {},
    sessions: { a: session("a", "idle", 0, "p") },
    viewed: {},
  };
  const out = orderMatched(input, p, "", false, "calm", "date", EMPTY_ORDER, OFF_HIDE);
  expect(out.collapsedOld).toEqual([]);
  expect(out.rows).toEqual(["a"]);
});
```

Append to `src/sidebar/Sidebar.test.tsx`:
```ts
test("a stale idle session folds under a 'N older — show' disclosure", async () => {
  const projectId = "proj-old";
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" },
  });
  const now = Date.now();
  useSessions.setState({
    activeSessionId: null,
    projects: [makeProject(projectId)],
    sessions: {
      fresh: {
        archivedAt: null, claudeSessionId: null, createdAt: now - 1000, cwd: "",
        id: "fresh", projectId, status: "idle", summary: "", title: "Fresh",
        worktreePath: null,
      },
      stale: {
        archivedAt: null, claudeSessionId: null, createdAt: now - 5 * 86_400_000,
        cwd: "", id: "stale", projectId, status: "idle", summary: "",
        title: "Stale one", worktreePath: null,
      },
    },
  });
  render(<Sidebar onNewSession={vi.fn()} />);
  // The stale row is hidden until the disclosure is opened.
  expect(screen.queryByText("Stale one")).not.toBeInTheDocument();
  const olderToggle = await screen.findByTestId(`older-summary-${projectId}`);
  fireEvent.click(olderToggle);
  expect(screen.getByText("Stale one")).toBeInTheDocument();
});
```
(Match the exact `Sidebar` render props already used elsewhere in the file — if the existing tests render `<Sidebar onNewSession={...} />` with more props, copy that call shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sidebar/sessionOrder.test.ts -t "collapsedOld" src/sidebar/Sidebar.test.tsx -t "older"`
Expected: FAIL — `orderMatched` has the wrong arity / `collapsedOld` undefined / no `older-summary` element.

- [ ] **Step 3a: Extend the ordering module**

In `src/sidebar/sessionOrder.ts`:

1. Add `collapsedOld` to `OrderedSessions`:
```ts
export interface OrderedSessions {
  /** Read (seen) Done ids folded behind the "N done" summary; `triage` only. */
  collapsedDone: string[];
  /** Stale ids folded behind the "N older" summary; empty when hiding is off. */
  collapsedOld: string[];
  /** Session ids rendered as full rows, in display order. */
  rows: string[];
}
```

2. Add the `HideInputs` interface (near `OrderInputs`):
```ts
/** The cross-store inputs the staleness fold needs, passed into orderMatched. */
export interface HideInputs {
  activeSessionId: string | null;
  lastChangeMs: Record<string, number>;
  now: number;
  threshold: HideOlderThan;
}
```

3. In `orderSessions`, add `collapsedOld: []` to **both** returned objects (the `calm` early return and the `triage` return) so the type is satisfied there; the actual fold happens in `computeMatched`.

4. Change `computeMatched` to accept and apply hide. Replace its body's `return orderSessions(...)` with:
```ts
function computeMatched(
  input: OrderInputs,
  project: ProjectRow,
  filter: string,
  nameMatch: boolean,
  mode: SidebarMode,
  sort: SessionSort,
  manual: string[],
  hide: HideInputs
): OrderedSessions {
  const list = Object.values(input.sessions).filter(
    (session) =>
      session.projectId === project.id &&
      session.archivedAt === null &&
      (filter === "" ||
        nameMatch ||
        session.title.toLowerCase().includes(filter))
  );
  const unseen = (id: string) =>
    unseenCount(input.viewed[id], input.appendSeq[id] ?? 0);
  const ordered = orderSessions(list, unseen, mode, sort, manual);
  const { collapsedOld, rows } = partitionOld(
    ordered.rows,
    input.sessions,
    hide.lastChangeMs,
    unseen,
    hide.activeSessionId,
    hide.threshold,
    hide.now
  );
  return { collapsedDone: ordered.collapsedDone, collapsedOld, rows };
}
```

5. Change `orderMatched` to take `hide: HideInputs`, add it to the cache key and guard, and pass it through:
```ts
export function orderMatched(
  input: OrderInputs,
  project: ProjectRow,
  filter: string,
  nameMatch: boolean,
  mode: SidebarMode,
  sort: SessionSort,
  manual: string[],
  hide: HideInputs
): OrderedSessions {
  let byKey = orderCache.get(input.sessions);
  if (!byKey) {
    byKey = new Map<string, OrderCacheEntry>();
    orderCache.set(input.sessions, byKey);
  }
  const key = JSON.stringify([
    project.id,
    nameMatch,
    mode,
    filter,
    sort,
    hide.threshold,
    hide.now,
    hide.activeSessionId,
  ]);
  const cached = byKey.get(key);
  if (
    cached &&
    cached.viewed === input.viewed &&
    cached.appendSeq === input.appendSeq &&
    cached.manual === manual &&
    cached.lastChangeMs === hide.lastChangeMs
  ) {
    return cached.result;
  }
  const result = computeMatched(
    input, project, filter, nameMatch, mode, sort, manual, hide
  );
  byKey.set(key, {
    appendSeq: input.appendSeq,
    lastChangeMs: hide.lastChangeMs,
    manual,
    result,
    viewed: input.viewed,
  });
  return result;
}
```

6. Add `lastChangeMs` to `OrderCacheEntry`:
```ts
interface OrderCacheEntry {
  appendSeq: Record<string, number>;
  lastChangeMs: Record<string, number>;
  manual: string[];
  result: OrderedSessions;
  viewed: Record<string, ViewedMarker>;
}
```

- [ ] **Step 3b: Wire ProjectGroup + Sidebar**

In `src/sidebar/ProjectGroup.tsx`:

1. Imports:
```ts
import { useCommandCenter } from "../state/commandCenter.ts";
```
Add `type HideOlderThan` is not needed here; `HideInputs` comes from sessionOrder — update that import:
```ts
import {
  EMPTY_ORDER,
  type HideInputs,
  type OrderInputs,
  orderMatched,
} from "./sessionOrder.ts";
```
Update the lucide import to add `Clock`:
```ts
import {
  ArrowUpDown, Check, ChevronRight, Clock, GitBranch, Palette, Plus,
} from "lucide-react";
```

2. Add `nowMinute` to `ProjectGroupProps`:
```ts
interface ProjectGroupProps {
  filter: string;
  /** Minute-quantized clock for the staleness fold; 0 when hiding is off. */
  nowMinute: number;
  onCloseSession: (id: string) => void;
  onSelect: (id: string) => void;
  project: ProjectRow;
}
```
and destructure `nowMinute` in the component signature.

3. In the component body, read the hide inputs and pass them to `orderMatched`. Replace the existing `orderMatched(...)` selector call:
```ts
const hideOlderThan = useLayout((state) => state.layout.hideOlderThan);
const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);
// Filtering shows every match (no fold), same guard as drag.
const hide: HideInputs = {
  activeSessionId: null, // set inside the selector from live store state
  lastChangeMs,
  now: nowMinute,
  threshold: filtering ? "off" : hideOlderThan,
};
const { collapsedDone, collapsedOld, rows } = useSessions((state) =>
  orderMatched(
    orderInputs(state),
    project,
    filter,
    nameMatch,
    listMode,
    sort,
    manual,
    { ...hide, activeSessionId: state.activeSessionId }
  )
);
```

4. Render the "N older" fold. Add local state beside `showDone`:
```ts
const [showOld, setShowOld] = useState(false);
```
Add a style near `doneSummaryStyle`:
```ts
/** The "N older" summary row that folds away stale sessions. */
const olderSummaryStyle: CSSProperties = doneSummaryStyle;
```
Inside `<div data-testid="project-children">`, after the `collapsedDone` block and **before** the `EarlierSessions` block, add:
```tsx
{collapsedOld.length > 0 ? (
  <>
    <button
      aria-expanded={showOld}
      className="kr-hover-surface"
      data-testid={`older-summary-${project.id}`}
      onClick={() => setShowOld((open) => !open)}
      style={olderSummaryStyle}
      type="button"
    >
      <span style={chevronStyle(showOld)}>
        <ChevronRight size={11} />
      </span>
      <Clock size={11} style={{ color: tokens.color.ink.dim, flex: "none" }} />
      <span style={{ flex: 1 }}>{collapsedOld.length} older</span>
    </button>
    {showOld
      ? collapsedOld.map((sessionId) => (
          <SessionRow
            key={sessionId}
            mode={mode}
            onCloseSession={onCloseSession}
            onSelect={onSelect}
            sessionId={sessionId}
            sortable={false}
          />
        ))
      : null}
  </>
) : null}
```

Note: `total` currently is `rows.length + collapsedDone.length`; include the folded-old count so the header count and the empty-filter guard stay honest:
```ts
const total = rows.length + collapsedDone.length + collapsedOld.length;
```

In `src/sidebar/Sidebar.tsx`:

1. Imports:
```ts
import { useEffect, useState } from "react";
```
(merge with the existing React import).

2. Add a minute-tick hook (module scope, above the `Sidebar` component):
```ts
/**
 * A minute-quantized clock, ticking only while `active`. Quantizing to the
 * minute means the staleness fold re-evaluates at most once a minute — enough
 * for hours/days cutoffs, cheap enough to leave the order cache mostly warm.
 * Returns 0 when inactive so an off filter never re-renders groups on a timer.
 */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return active ? Math.floor(now / 60_000) * 60_000 : 0;
}
```

3. In the `Sidebar` component body:
```ts
const hideOlderThan = useLayout((state) => state.layout.hideOlderThan);
const nowMinute = useMinuteTick(hideOlderThan !== "off");
```

4. Pass `nowMinute={nowMinute}` to each `<ProjectGroup .../>` in the render map.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/sidebar/sessionOrder.test.ts src/sidebar/Sidebar.test.tsx`
Expected: PASS (new tests plus the previously-passing ones — the `orderMatched` call sites in the test file were updated in Step 1).

- [ ] **Step 5: Full check + commit**

Run: `pnpm fix && pnpm check`
Expected: green (this also confirms every `orderMatched` caller passes the new `hide` arg).
```bash
git add src/sidebar/sessionOrder.ts src/sidebar/ProjectGroup.tsx src/sidebar/Sidebar.tsx src/sidebar/sessionOrder.test.ts src/sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): fold stale sessions into a per-group 'N older' disclosure"
```

---

### Task 6: "Hide older than" control in the global sort popover

**Files:**
- Modify: `src/sidebar/SortMenu.tsx` (optional hide section)
- Modify: `src/sidebar/Sidebar.tsx` (pass the hide section to the global `SortMenu` only)
- Test: `src/sidebar/Sidebar.test.tsx` (append)

**Interfaces:**
- Consumes: `HideOlderThan`, `useLayout().setHideOlderThan` (Task 2).
- Produces: `SortMenu` gains an optional prop `hide?: { current: HideOlderThan; onPick: (value: HideOlderThan) => void }`. When present, a divider + a "Hide older than" radio group renders below the sort radios. Per-project pickers omit it.

- [ ] **Step 1: Write the failing test**

Append to `src/sidebar/Sidebar.test.tsx`:
```ts
test("the global sort popover offers hide-older-than options that update layout", async () => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useSessions.setState({ projects: [], sessions: {}, activeSessionId: null });
  render(<Sidebar onNewSession={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Sort sessions" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "3 days" }));
  expect(useLayout.getState().layout.hideOlderThan).toBe("3d");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx -t "hide-older-than options"`
Expected: FAIL — no "3 days" menuitemradio.

- [ ] **Step 3: Implement**

In `src/sidebar/SortMenu.tsx`:

1. Import the type:
```ts
import type { HideOlderThan, SessionSort } from "../state/layout.ts";
```

2. Add labels + a divider style (tokens only):
```ts
const HIDE_LABELS: Record<HideOlderThan, string> = {
  "1d": "1 day",
  "1w": "1 week",
  "3d": "3 days",
  "6h": "6 hours",
  off: "Off",
};
const HIDE_ORDER: readonly HideOlderThan[] = ["off", "6h", "1d", "3d", "1w"];

const dividerStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.hairline}`,
  margin: "4px 2px",
};

const sectionLabelStyle: CSSProperties = {
  color: tokens.color.ink.ghost,
  fontFamily: tokens.font.sans,
  fontSize: "9.5px",
  fontWeight: 600,
  letterSpacing: "0.06em",
  padding: "4px 8px 2px",
  textTransform: "uppercase",
};
```
(If `tokens.color.line.hairline` does not exist, use the nearest existing hairline/border token — check `src/theme/tokens.ts` and pick the divider/border color already used for separators.)

3. Extend the props + render:
```ts
interface SortMenuProps {
  current: SessionSort;
  /** Global picker only: renders a "Hide older than" section. Null/omitted on
   *  per-project pickers. */
  hide?: {
    current: HideOlderThan;
    onPick: (value: HideOlderThan) => void;
  };
  onFollowGlobal: (() => void) | null;
  onPick: (mode: SessionSort) => void;
}

export function SortMenu({ current, hide, onFollowGlobal, onPick }: SortMenuProps) {
  return (
    <div role="menu" style={surfaceStyle}>
      {/* ...existing sort radios unchanged... */}
      {/* ...existing Follow global button unchanged... */}
      {hide ? (
        <>
          <div style={dividerStyle} />
          <div style={sectionLabelStyle}>Hide older than</div>
          {HIDE_ORDER.map((value) => (
            <button
              aria-checked={hide.current === value}
              className="kr-hover-surface"
              key={value}
              onClick={() => hide.onPick(value)}
              role="menuitemradio"
              style={itemStyle(hide.current === value)}
              type="button"
            >
              <span style={{ flex: "none", width: "12px" }}>
                {hide.current === value ? "✓" : ""}
              </span>
              {HIDE_LABELS[value]}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
```

In `src/sidebar/Sidebar.tsx`, pass `hide` to the **global** `SortMenu` (the one at ~line 171). `hideOlderThan` is already read (Task 5 step 3):
```tsx
<SortMenu
  current={sessionSort}
  hide={{
    current: hideOlderThan,
    onPick: (value) => {
      useLayout.getState().setHideOlderThan(value);
      sortMenu.close();
    },
  }}
  onFollowGlobal={null}
  onPick={(mode) => {
    useLayout.getState().setSessionSort(mode);
    sortMenu.close();
  }}
/>
```
Leave the per-project `SortMenu` in `ProjectGroup.tsx` **without** a `hide` prop.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx -t "hide-older-than options"`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `pnpm fix && pnpm check`
Expected: green.
```bash
git add src/sidebar/SortMenu.tsx src/sidebar/Sidebar.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): hide-older-than control in the global sort popover"
```

---

## Self-review notes

- **Spec coverage:** Grip handle → Task 1. `hideOlderThan` field/setter → Task 2; persistence → Task 3; `partitionOld` (exemptions, thresholds, age basis) → Task 4; both-mode fold + minute-quantized `now` + memo integration + "N older" UI + filter guard → Task 5; global-only control in the ↕ popover → Task 6. All spec sections map to a task.
- **Type consistency:** `partitionOld` signature is defined once (Task 4) and consumed unchanged (Task 5). `HideInputs` and the extended `orderMatched` arity are defined in Task 5 and every caller (component + tests) is updated in the same task; `pnpm check` in Task 5 Step 5 is the arity guard. `SortMenu`'s `hide` prop shape is defined in Task 6 and used only there.
- **Accepted limitation:** after a restart, age falls back to `createdAt` until the command center observes the first live status change (spec, "Age basis").
- **Token check:** any token guessed above (`tokens.color.line.hairline`) must be confirmed against `src/theme/tokens.ts` at implementation time and swapped for the real separator/hairline token if the name differs — do not hardcode a color.
```
