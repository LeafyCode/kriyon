# Sidebar Session Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag-to-reorder sessions inside a sidebar project group with the order remembered, plus a sort-mode picker (manual / date / name) — global with per-project overrides.

**Architecture:** Sort state lives in the layout store (`useLayout`) and persists through the existing `saveLayout` blob. All ordering stays pure in `src/sidebar/sessionOrder.ts`. Drag is dnd-kit (classic stable packages) scoped per project group; a drop writes the full order and pins that project to `manual`.

**Tech Stack:** React 19, Zustand 5, dnd-kit (`@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`), Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-19-sidebar-session-sorting-design.md`

## Global Constraints

- `pnpm` for everything; run `pnpm fix` before committing (Ultracite owns formatting — never hand-format).
- Conventional commits; commit after every task; stage **named files only** (other sessions may share this checkout — never `git add -u`).
- Design values come from `src/theme/tokens.ts`; no hardcoded colors/spacing.
- Defaults: global sort `"date"`; changing the global sort clears every per-project override but **keeps** `manualSessionOrder`.
- Triage mode: status-floating applies **only** when the effective sort is `"date"`; the read-Done fold applies in triage under every sort.
- New spec deviation, agreed in design: the reorder action is `setManualSessionOrder(projectId, orderedIds)` (full-list write), not the spec's sketched `moveSession(projectId, sessionId, toIndex)`.

---

### Task 1: `SessionSort` state in the layout store

**Files:**
- Modify: `src/state/layout.ts`
- Test: `src/state/layout.test.ts`

**Interfaces:**
- Consumes: existing `Layout`, `useLayout`, `DEFAULT_LAYOUT`.
- Produces (later tasks rely on these exact names):
  - `export type SessionSort = "manual" | "date" | "name"`
  - `Layout` fields: `sessionSort: SessionSort`, `projectSortOverrides: Record<string, SessionSort>`, `manualSessionOrder: Record<string, string[]>`
  - Actions: `setSessionSort(mode: SessionSort): void`, `setProjectSort(projectId: string, mode: SessionSort | null): void`, `setManualSessionOrder(projectId: string, orderedIds: string[]): void`
  - Helper: `export function effectiveSessionSort(layout: Layout, projectId: string): SessionSort`

- [ ] **Step 1: Write the failing tests** — append to `src/state/layout.test.ts`:

```ts
test("setSessionSort sets the global mode and clears every project override", () => {
  const s = useLayout.getState();
  s.setProjectSort("p1", "name");
  s.setProjectSort("p2", "manual");
  useLayout.getState().setSessionSort("name");
  expect(useLayout.getState().layout.sessionSort).toBe("name");
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("setSessionSort keeps remembered manual orders", () => {
  useLayout.getState().setManualSessionOrder("p1", ["b", "a"]);
  useLayout.getState().setSessionSort("date");
  expect(useLayout.getState().layout.manualSessionOrder).toEqual({
    p1: ["b", "a"],
  });
});

test("setProjectSort sets and clears one project's override", () => {
  useLayout.getState().setProjectSort("p1", "manual");
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({
    p1: "manual",
  });
  useLayout.getState().setProjectSort("p1", null);
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("setManualSessionOrder writes the order and pins the project to manual", () => {
  useLayout.getState().setManualSessionOrder("p1", ["c", "a", "b"]);
  const { layout } = useLayout.getState();
  expect(layout.manualSessionOrder.p1).toEqual(["c", "a", "b"]);
  expect(layout.projectSortOverrides.p1).toBe("manual");
});

test("setManualSessionOrder never pins when the project is already manual", () => {
  useLayout.getState().setSessionSort("manual");
  useLayout.getState().setManualSessionOrder("p1", ["a", "b"]);
  // Global is manual, so no override needed — a later global change resets
  // overrides and this project should follow it again.
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("effectiveSessionSort prefers the project override", () => {
  useLayout.getState().setSessionSort("name");
  useLayout.getState().setProjectSort("p1", "manual");
  const { layout } = useLayout.getState();
  expect(effectiveSessionSort(layout, "p1")).toBe("manual");
  expect(effectiveSessionSort(layout, "p2")).toBe("name");
});
```

Add `effectiveSessionSort` to the import from `./layout.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state/layout.test.ts`
Expected: FAIL — `effectiveSessionSort` not exported / actions undefined.

- [ ] **Step 3: Implement** in `src/state/layout.ts`:

Add after `MenuBarMode`:

```ts
/** How sessions inside a project group are ordered. */
export type SessionSort = "manual" | "date" | "name";
```

Add to `Layout` (keep alphabetical-ish placement with the other fields):

```ts
  /** Per-project drag-arranged session-id order, used by `manual` sort. */
  manualSessionOrder: Record<string, string[]>;
  /** Per-project sort override; absent = follow the global `sessionSort`. */
  projectSortOverrides: Record<string, SessionSort>;
  /** Global session sort inside each project group. */
  sessionSort: SessionSort;
```

Add to `DEFAULT_LAYOUT`:

```ts
  manualSessionOrder: {},
  projectSortOverrides: {},
  sessionSort: "date",
```

Add the helper (near `clampSidebarWidth`):

```ts
/** The sort a project group actually uses: its override, else the global. */
export function effectiveSessionSort(
  layout: Layout,
  projectId: string
): SessionSort {
  return layout.projectSortOverrides[projectId] ?? layout.sessionSort;
}
```

Add to `LayoutState` interface:

```ts
  setManualSessionOrder: (projectId: string, orderedIds: string[]) => void;
  setProjectSort: (projectId: string, mode: SessionSort | null) => void;
  setSessionSort: (mode: SessionSort) => void;
```

Add the actions in `useLayout`:

```ts
  setSessionSort: (sessionSort) =>
    set((state) => ({
      // Changing the global resets every per-project choice (design rule);
      // manual arrangements are positions, not a mode, so they survive.
      layout: { ...state.layout, projectSortOverrides: {}, sessionSort },
    })),
  setProjectSort: (projectId, mode) =>
    set((state) => {
      const overrides = { ...state.layout.projectSortOverrides };
      if (mode === null) {
        delete overrides[projectId];
      } else {
        overrides[projectId] = mode;
      }
      return { layout: { ...state.layout, projectSortOverrides: overrides } };
    }),
  setManualSessionOrder: (projectId, orderedIds) =>
    set((state) => {
      const layout = {
        ...state.layout,
        manualSessionOrder: {
          ...state.layout.manualSessionOrder,
          [projectId]: orderedIds,
        },
      };
      // A drop must stick regardless of the global mode — pin the project to
      // manual unless it already resolves to manual.
      if (effectiveSessionSort(state.layout, projectId) !== "manual") {
        layout.projectSortOverrides = {
          ...state.layout.projectSortOverrides,
          [projectId]: "manual",
        };
      }
      return { layout };
    }),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state/layout.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/layout.ts src/state/layout.test.ts
git commit -m "feat(sidebar): session sort state — global mode, overrides, manual order"
```

---

### Task 2: Persist the three sort fields

**Files:**
- Modify: `src/state/persistence.ts` (inside `parseLayout` and the validator block above it)
- Test: `src/state/persistence.test.ts`

**Interfaces:**
- Consumes: `SessionSort` from Task 1 (`import type { ... SessionSort } from "./layout.ts"`), existing `parseLayout(json: string | null): Layout | undefined`.
- Produces: `parseLayout` now returns the three new fields, validated. (Saving needs no change — the layout persister writes the whole `layout` object.)

- [ ] **Step 1: Write the failing tests** — append to `src/state/persistence.test.ts` (follow the file's existing `parseLayout` test style; check the top of the file for how it builds layout JSON):

```ts
test("parseLayout restores session sort, overrides, and manual orders", () => {
  const layout = parseLayout(
    JSON.stringify({
      manualSessionOrder: { p1: ["b", "a"] },
      projectSortOverrides: { p1: "manual", p2: "name" },
      sessionSort: "name",
    })
  );
  expect(layout?.sessionSort).toBe("name");
  expect(layout?.projectSortOverrides).toEqual({ p1: "manual", p2: "name" });
  expect(layout?.manualSessionOrder).toEqual({ p1: ["b", "a"] });
});

test("parseLayout drops malformed sort values instead of poisoning the store", () => {
  const layout = parseLayout(
    JSON.stringify({
      manualSessionOrder: { ok: ["a"], bad: [1, 2], worse: "x" },
      projectSortOverrides: { ok: "date", bad: "sideways", worse: 7 },
      sessionSort: "sideways",
    })
  );
  expect(layout?.sessionSort).toBe("date");
  expect(layout?.projectSortOverrides).toEqual({ ok: "date" });
  expect(layout?.manualSessionOrder).toEqual({ ok: ["a"] });
});

test("parseLayout defaults the sort fields when absent (older blob)", () => {
  const layout = parseLayout(JSON.stringify({ view: "studio" }));
  expect(layout?.sessionSort).toBe("date");
  expect(layout?.projectSortOverrides).toEqual({});
  expect(layout?.manualSessionOrder).toEqual({});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state/persistence.test.ts`
Expected: FAIL — new fields missing from the returned layout (TypeScript may also fail first; that counts).

- [ ] **Step 3: Implement** — in `src/state/persistence.ts`, next to `parseSidebarMode`:

```ts
const SESSION_SORTS: readonly SessionSort[] = ["manual", "date", "name"];

/** Validate a persisted session sort, defaulting to `date`. */
function parseSessionSort(value: unknown): SessionSort {
  return SESSION_SORTS.includes(value as SessionSort)
    ? (value as SessionSort)
    : "date";
}

/** Keep only entries whose value is a valid {@link SessionSort}. */
function parseSortOverrides(value: unknown): Record<string, SessionSort> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const out: Record<string, SessionSort> = {};
  for (const [key, mode] of Object.entries(value)) {
    if (SESSION_SORTS.includes(mode as SessionSort)) {
      out[key] = mode as SessionSort;
    }
  }
  return out;
}

/** Keep only entries whose value is an array of session-id strings. */
function parseManualOrders(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value)) {
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
      out[key] = ids;
    }
  }
  return out;
}
```

Import `SessionSort` as a type from `./layout.ts`, and add to `parseLayout`'s returned object:

```ts
    manualSessionOrder: parseManualOrders(parsed.manualSessionOrder),
    projectSortOverrides: parseSortOverrides(parsed.projectSortOverrides),
    sessionSort: parseSessionSort(parsed.sessionSort),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat(sidebar): persist session sort mode, overrides, and manual order"
```

---

### Task 3: Ordering semantics in `sessionOrder.ts`

**Files:**
- Modify: `src/sidebar/sessionOrder.ts`
- Test: `src/sidebar/sessionOrder.test.ts`

**Interfaces:**
- Consumes: `SessionSort` from Task 1.
- Produces (exact signatures Task 4 wires up):
  - `orderSessions(sessions: UiSession[], unseen: (id: string) => number, mode: SidebarMode, sort: SessionSort, manual: string[]): OrderedSessions`
  - `orderMatched(input: OrderInputs, project: ProjectRow, filter: string, nameMatch: boolean, mode: SidebarMode, sort: SessionSort, manual: string[]): OrderedSessions`
  - `dropOrder(rows: string[], collapsedDone: string[], activeId: string, overId: string | null): string[] | null` — the pure result of a drag-drop; null when nothing should change.

Note: `manual` is the project's saved id list (`manualSessionOrder[projectId] ?? EMPTY_ORDER`). Export `const EMPTY_ORDER: string[] = []` from `sessionOrder.ts` so callers pass a stable identity when there is no saved order (the memo cache guards on identity).

- [ ] **Step 1: Write the failing tests** — the existing tests call `orderSessions(sessions, unseen, mode)`; update every existing call to pass `, "date", EMPTY_ORDER` (behavior identical), then append:

```ts
test("name sort orders alphabetically by title in calm mode", () => {
  const sessions = [
    { ...session("a", "idle", 1), title: "zeta" },
    { ...session("b", "running", 2), title: "alpha" },
    { ...session("c", "done", 3), title: "mid" },
  ];
  const { rows } = orderSessions(sessions, noneUnseen, "calm", "name", EMPTY_ORDER);
  expect(rows).toEqual(["b", "c", "a"]);
});

test("name sort fully wins in triage — no status floating, done still folds", () => {
  const sessions = [
    { ...session("w", "waiting", 1), title: "zzz waiting" },
    { ...session("r", "running", 2), title: "aaa running" },
    { ...session("d", "done", 3), title: "mmm done" }, // read → folds
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "name",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["r", "w"]);
  expect(collapsedDone).toEqual(["d"]);
});

test("date sort in triage keeps status floating (today's behavior)", () => {
  const sessions = [
    session("i", "idle", 9),
    session("w", "waiting", 1),
  ];
  const { rows } = orderSessions(sessions, noneUnseen, "triage", "date", EMPTY_ORDER);
  expect(rows).toEqual(["w", "i"]);
});

test("manual sort follows the saved order and ignores stale ids", () => {
  const sessions = [session("a", "idle", 1), session("b", "idle", 2), session("c", "idle", 3)];
  const { rows } = orderSessions(
    sessions,
    noneUnseen,
    "calm",
    "manual",
    ["gone", "b", "c", "a"]
  );
  expect(rows).toEqual(["b", "c", "a"]);
});

test("manual sort puts unlisted (new) sessions on top, newest first", () => {
  const sessions = [
    session("old", "idle", 1),
    session("new1", "idle", 5),
    session("new2", "idle", 7),
  ];
  const { rows } = orderSessions(sessions, noneUnseen, "calm", "manual", ["old"]);
  expect(rows).toEqual(["new2", "new1", "old"]);
});

test("manual sort fully wins in triage but read done still folds", () => {
  const sessions = [
    session("w", "waiting", 1),
    session("r", "running", 2),
    session("d", "done", 3),
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "manual",
    ["r", "w", "d"]
  );
  expect(rows).toEqual(["r", "w"]);
  expect(collapsedDone).toEqual(["d"]);
});

// --- dropOrder ---

test("dropOrder moves the dragged id before/after its target and appends folded done", () => {
  expect(dropOrder(["a", "b", "c"], ["d1"], "a", "c")).toEqual(["b", "c", "a", "d1"]);
  expect(dropOrder(["a", "b", "c"], [], "c", "a")).toEqual(["c", "a", "b"]);
});

test("dropOrder returns null when the drop changes nothing", () => {
  expect(dropOrder(["a", "b"], [], "a", "a")).toBeNull();
  expect(dropOrder(["a", "b"], [], "a", null)).toBeNull();
  expect(dropOrder(["a", "b"], [], "missing", "b")).toBeNull();
});
```

Import `dropOrder` and `EMPTY_ORDER` from `./sessionOrder.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sidebar/sessionOrder.test.ts`
Expected: FAIL — wrong arity / missing exports.

- [ ] **Step 3: Implement** in `src/sidebar/sessionOrder.ts`:

```ts
import type { SessionSort, SidebarMode } from "../state/layout.ts";

/** Stable empty manual order — callers pass this when a project has none, so
 *  the memo cache's identity guard sees one unchanged value. */
export const EMPTY_ORDER: string[] = [];

/** Order a list by one sort mode. `manual` keeps unlisted (new) sessions on
 *  top, newest first, above the user's arranged block; stale ids are ignored. */
function sortBy(
  sessions: UiSession[],
  sort: SessionSort,
  manual: string[]
): UiSession[] {
  const newestFirst = (a: UiSession, b: UiSession) => b.createdAt - a.createdAt;
  if (sort === "name") {
    return [...sessions].sort(
      (a, b) => a.title.localeCompare(b.title) || newestFirst(a, b)
    );
  }
  if (sort === "manual") {
    const position = new Map(manual.map((id, index) => [id, index]));
    const placed = sessions
      .filter((s) => position.has(s.id))
      .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    const unplaced = sessions
      .filter((s) => !position.has(s.id))
      .sort(newestFirst);
    return [...unplaced, ...placed];
  }
  return [...sessions].sort(newestFirst);
}
```

Rewrite `orderSessions`:

```ts
export function orderSessions(
  sessions: UiSession[],
  unseen: (id: string) => number,
  mode: SidebarMode,
  sort: SessionSort,
  manual: string[]
): OrderedSessions {
  const open = sessions.filter((session) => session.archivedAt === null);

  if (mode === "calm") {
    return {
      collapsedDone: [],
      rows: sortBy(open, sort, manual).map((session) => session.id),
    };
  }

  // Triage always folds read Done away; folding is collapsing, not ordering.
  const active: UiSession[] = [];
  const readDone: UiSession[] = [];
  for (const session of open) {
    if (session.status === "done" && unseen(session.id) === 0) {
      readDone.push(session);
    } else {
      active.push(session);
    }
  }
  const sorted = sortBy(active, sort, manual);
  return {
    collapsedDone: sortBy(readDone, "date", EMPTY_ORDER).map((s) => s.id),
    // Status floating is the *default* triage ordering; an explicit manual or
    // name sort fully wins (design: a drop stays exactly where you put it).
    rows: (sort === "date"
      ? sorted.sort((a, b) => sessionRank(a.status) - sessionRank(b.status))
      : sorted
    ).map((session) => session.id),
  };
}
```

(Note: `sorted` is already a fresh array, so the in-place `.sort` by rank is safe, and Array.sort is stable so the date order survives within a rank.)

Add `dropOrder`:

```ts
/**
 * The manual order a drop produces: `activeId` moved to `overId`'s position
 * within the visible rows, with the folded read-Done ids appended so a later
 * mode switch cannot mistake them for "new" (unlisted floats to the top).
 * Null when the drop is a no-op.
 */
export function dropOrder(
  rows: string[],
  collapsedDone: string[],
  activeId: string,
  overId: string | null
): string[] | null {
  if (overId === null || activeId === overId) {
    return null;
  }
  const from = rows.indexOf(activeId);
  const to = rows.indexOf(overId);
  if (from === -1 || to === -1) {
    return null;
  }
  const next = [...rows];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return [...next, ...collapsedDone];
}
```

Thread `sort`/`manual` through `computeMatched` and `orderMatched` (same two extra trailing params), and extend the cache: add `sort` to the JSON key (`JSON.stringify([project.id, nameMatch, mode, filter, sort])`) and add `manual` to `OrderCacheEntry` with an identity guard alongside `viewed`/`appendSeq`:

```ts
  if (
    cached &&
    cached.viewed === input.viewed &&
    cached.appendSeq === input.appendSeq &&
    cached.manual === manual
  ) {
    return cached.result;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/sidebar/`
Expected: PASS (TypeScript will flag `ProjectGroup.tsx`'s old 5-arg `orderMatched` calls — fix them in Step 5's minimal wiring below before committing).

- [ ] **Step 5: Minimal wiring in `ProjectGroup.tsx`** so the app compiles and sorts (no drag yet). Add imports:

```ts
import { effectiveSessionSort, type SidebarMode, useLayout } from "../state/layout.ts";
import { EMPTY_ORDER, type OrderInputs, orderMatched } from "./sessionOrder.ts";
```

Inside the component, before the `rows` selector:

```ts
  const sort = useLayout((state) =>
    effectiveSessionSort(state.layout, project.id)
  );
  const manual = useLayout(
    (state) => state.layout.manualSessionOrder[project.id] ?? EMPTY_ORDER
  );
```

Pass `sort, manual` as the two new trailing args of both `orderMatched(...)` calls.

Run: `pnpm vitest run src/sidebar/ && pnpm exec tsc --noEmit`
Expected: PASS, clean compile.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add src/sidebar/sessionOrder.ts src/sidebar/sessionOrder.test.ts src/sidebar/ProjectGroup.tsx
git commit -m "feat(sidebar): sort-aware session ordering with manual/date/name semantics"
```

---

### Task 4: Drag-to-reorder with dnd-kit

**Files:**
- Modify: `package.json` (via `pnpm add`), `src/sidebar/ProjectGroup.tsx`, `src/sidebar/SessionRow.tsx`
- Test: `src/sidebar/Sidebar.test.tsx` (render-only sanity; drop math is already covered by `dropOrder` units)

**Interfaces:**
- Consumes: `dropOrder`, `EMPTY_ORDER` (Task 3); `setManualSessionOrder` (Task 1).
- Produces: `SessionRow` gains a required prop `sortable: boolean`. `ProjectGroup` wraps its children in `DndContext` + `SortableContext`.

- [ ] **Step 1: Install** (stable classic packages — NOT the experimental `@dnd-kit/react`):

```bash
pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

- [ ] **Step 2: Make `SessionRow` sortable.** In `src/sidebar/SessionRow.tsx`:

```ts
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
```

Add `sortable: boolean;` to `SessionRowProps` (doc: `/** Row may be drag-reordered — off while filtering and for folded Done rows. */`) and destructure it. Inside the component:

```ts
  const sortableRow = useSortable({ disabled: !sortable, id: sessionId });
```

The row's outer `<div>` currently gets `ref={menu.anchorRef}`. Both dnd-kit and the menu need that node — merge the refs:

```tsx
      ref={(node: HTMLDivElement | null) => {
        menu.anchorRef.current = node;
        sortableRow.setNodeRef(node);
      }}
```

Extend the outer div's style and spread the drag props:

```tsx
      style={{
        ...sessionRowStyle(active, session.status),
        transform: CSS.Transform.toString(sortableRow.transform),
        transition: sortableRow.transition,
        ...(sortableRow.isDragging
          ? { opacity: 0.75, position: "relative", zIndex: tokens.z.sticky }
          : null),
      }}
      {...sortableRow.attributes}
      {...sortableRow.listeners}
```

(`attributes`/`listeners` go on the row div — the whole row is the handle. The activation distance in Task 4 Step 3 keeps plain clicks selecting; note `sessionRowStyle` already sets `position: "relative"`, the isDragging spread just re-asserts it with a raised z-index from tokens.)

- [ ] **Step 3: Scope a `DndContext` per project group.** In `src/sidebar/ProjectGroup.tsx`:

```ts
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { dropOrder, EMPTY_ORDER, type OrderInputs, orderMatched } from "./sessionOrder.ts";
```

Inside the component:

```ts
  // Drag starts only after 6px of travel, so plain clicks still select rows.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  function onDragEnd(event: DragEndEvent): void {
    const next = dropOrder(
      rows,
      collapsedDone,
      String(event.active.id),
      event.over ? String(event.over.id) : null
    );
    if (next) {
      useLayout.getState().setManualSessionOrder(project.id, next);
    }
  }
```

Wrap the children container (dragging is disabled while filtering — a drop on a subset would silently rewrite the order without the hidden sessions):

```tsx
      {showChildren ? (
        <DndContext
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          sensors={sensors}
        >
          <div data-testid="project-children" style={groupChildrenStyle}>
            <SortableContext
              items={rows}
              strategy={verticalListSortingStrategy}
            >
              {rows.map((sessionId) => (
                <SessionRow
                  key={sessionId}
                  mode={mode}
                  onCloseSession={onCloseSession}
                  onSelect={onSelect}
                  sessionId={sessionId}
                  sortable={!filtering}
                />
              ))}
            </SortableContext>
            {/* done-summary block: pass sortable={false} to those SessionRows */}
            ...
          </div>
        </DndContext>
      ) : null}
```

Keep the existing done-summary and `EarlierSessions` blocks inside the `<div>` but outside `SortableContext`; the expanded `collapsedDone.map` rows get `sortable={false}`.

Also check `src/sidebar/NeedsYouSection.tsx` and any other `<SessionRow` call sites (`grep -rn "<SessionRow" src/`) — pass `sortable={false}` anywhere else it renders. If a call site renders outside any `DndContext`, classic dnd-kit's `useSortable` works with library defaults (no provider required, no crash) — but verify by running the full test suite.

- [ ] **Step 4: Render sanity test** — in `src/sidebar/Sidebar.test.tsx`, follow the file's existing setup helpers (it seeds `useSessions`/`useLayout` in `beforeEach`) and add:

```tsx
test("session rows render draggable attributes inside a project group", () => {
  // Reuse the file's existing render helper/seeded state.
  const rows = screen.getAllByTestId("session-row");
  expect(rows.length).toBeGreaterThan(0);
  // dnd-kit stamps sortable rows with role=button + aria-roledescription.
  expect(rows[0]?.getAttribute("aria-roledescription")).toBe("sortable");
});
```

Adapt to the file's actual helpers when writing it (read the file first; it already renders `<Sidebar …>` with seeded sessions).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/sidebar/ && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add package.json pnpm-lock.yaml src/sidebar/SessionRow.tsx src/sidebar/ProjectGroup.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): drag-to-reorder sessions within a project group"
```

---

### Task 5: Global sort picker in the filter row

**Files:**
- Modify: `src/sidebar/Sidebar.tsx`
- Test: `src/sidebar/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `setSessionSort`, `sessionSort` (Task 1); `useAnchoredMenu`, `anchoredMenuSurfaceStyle` from `../ui/AnchoredMenu.tsx`.
- Produces: a shared `SortMenu` component in a new file `src/sidebar/SortMenu.tsx` that Task 6 reuses.

- [ ] **Step 1: Write the failing test** — in `src/sidebar/Sidebar.test.tsx`:

```tsx
test("the sort button switches the global session sort", async () => {
  // Reuse the file's render helper.
  await userEvent.click(screen.getByLabelText("Sort sessions"));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
  expect(useLayout.getState().layout.sessionSort).toBe("name");
  // Picking a global mode resets any per-project override.
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});
```

(If the file uses `fireEvent` instead of `userEvent`, follow the file's idiom.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx`
Expected: FAIL — no "Sort sessions" control.

- [ ] **Step 3: Create `src/sidebar/SortMenu.tsx`** — one popover both pickers share:

```tsx
import type { CSSProperties } from "react";
import type { SessionSort } from "../state/layout.ts";
import { tokens } from "../theme/tokens.ts";
import { anchoredMenuSurfaceStyle } from "../ui/AnchoredMenu.tsx";

const SORT_LABELS: Record<SessionSort, string> = {
  date: "Date",
  manual: "Manual",
  name: "Name",
};

const surfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  minWidth: "150px",
  padding: "4px",
};

function itemStyle(selected: boolean): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    borderRadius: tokens.radius.sm,
    color: selected ? tokens.color.ink.bright : tokens.color.ink.primary,
    cursor: "pointer",
    display: "flex",
    fontFamily: tokens.font.sans,
    fontSize: "12px",
    gap: "7px",
    padding: "6px 8px",
    textAlign: "left",
    width: "100%",
  };
}

interface SortMenuProps {
  /** The mode currently in effect (for the ✓ mark). */
  current: SessionSort;
  /** "Follow global" row — per-project menus only; null hides it. */
  onFollowGlobal: (() => void) | null;
  onPick: (mode: SessionSort) => void;
}

/** The Manual / Date / Name radio popover, shared by the global and
 *  per-project sort pickers. Caller owns open state and the anchor. */
export function SortMenu({ current, onFollowGlobal, onPick }: SortMenuProps) {
  return (
    <div role="menu" style={surfaceStyle}>
      {(Object.keys(SORT_LABELS) as SessionSort[]).map((mode) => (
        <button
          aria-checked={current === mode}
          className="kr-hover-surface"
          key={mode}
          onClick={() => onPick(mode)}
          role="menuitemradio"
          style={itemStyle(current === mode)}
          type="button"
        >
          <span style={{ flex: "none", width: "12px" }}>
            {current === mode ? "✓" : ""}
          </span>
          {SORT_LABELS[mode]}
        </button>
      ))}
      {onFollowGlobal ? (
        <button
          className="kr-hover-surface"
          onClick={onFollowGlobal}
          role="menuitem"
          style={{ ...itemStyle(false), color: tokens.color.ink.muted }}
          type="button"
        >
          <span style={{ flex: "none", width: "12px" }} />
          Follow global
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire into `Sidebar.tsx`.** Import `ArrowUpDown` from `lucide-react`, `SortMenu`, `useAnchoredMenu`. In the component:

```ts
  const sessionSort = useLayout((state) => state.layout.sessionSort);
  const sortMenu = useAnchoredMenu<HTMLDivElement>();
```

In the filter row, after the filter box and before the `+` button (a relative wrapper anchors the popover):

```tsx
        <div ref={sortMenu.anchorRef} style={{ position: "relative" }}>
          <button
            aria-label="Sort sessions"
            className="kr-hover-surface"
            onClick={() => sortMenu.toggle()}
            style={newButtonStyle}
            title="Sort sessions"
            type="button"
            {...sortMenu.triggerAria}
          >
            <ArrowUpDown size={13} />
          </button>
          {sortMenu.open ? (
            <SortMenu
              current={sessionSort}
              onFollowGlobal={null}
              onPick={(mode) => {
                useLayout.getState().setSessionSort(mode);
                sortMenu.close();
              }}
            />
          ) : null}
        </div>
```

(`anchoredMenuSurfaceStyle` anchors at `right: 9px; top: 100%` of the wrapper — fine here.)

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add src/sidebar/SortMenu.tsx src/sidebar/Sidebar.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): global session-sort picker (manual/date/name)"
```

---

### Task 6: Per-project sort override in the header

**Files:**
- Modify: `src/sidebar/ProjectGroup.tsx`
- Test: `src/sidebar/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `SortMenu` (Task 5), `setProjectSort` + `effectiveSessionSort` (Task 1), existing header hover-button pattern (`projectAddStyle`, `kr-reveal kr-hover-surface`).

- [ ] **Step 1: Write the failing test** — in `src/sidebar/Sidebar.test.tsx` (the seeded project's name is whatever the file's helper uses; adapt):

```tsx
test("a project sort override is set from the header and survives a Follow global", async () => {
  await userEvent.click(
    screen.getByLabelText(/Sort sessions in /)
  );
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Manual" }));
  const overrides = () => useLayout.getState().layout.projectSortOverrides;
  expect(Object.values(overrides())).toEqual(["manual"]);

  await userEvent.click(screen.getByLabelText(/Sort sessions in /));
  await userEvent.click(screen.getByRole("menuitem", { name: "Follow global" }));
  expect(overrides()).toEqual({});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx`
Expected: FAIL — no such control.

- [ ] **Step 3: Implement** in `ProjectGroup.tsx`. Import `ArrowUpDown` (extend the lucide import), `SortMenu`. The header already anchors one popover (`picker`); add a second anchored menu on the same header container:

```ts
  const sortMenu = useAnchoredMenu<HTMLDivElement>();
  const override = useLayout(
    (state) => state.layout.projectSortOverrides[project.id]
  );
```

(`sort` — the effective mode — already exists from Task 3 Step 5.)

Add a button in the hover cluster before the palette button. An active override keeps the icon visible (skip `kr-reveal`) so a pinned project is recognizable:

```tsx
        <button
          aria-label={`Sort sessions in ${project.name}`}
          className={
            override ? "kr-hover-surface" : "kr-reveal kr-hover-surface"
          }
          onClick={() => sortMenu.toggle()}
          style={projectAddStyle}
          title={
            override
              ? `Sorted by ${override} (overrides global)`
              : "Sort this project's sessions"
          }
          type="button"
          {...sortMenu.triggerAria}
        >
          <ArrowUpDown size={12} />
        </button>
        {sortMenu.open ? (
          <SortMenu
            current={sort}
            onFollowGlobal={() => {
              useLayout.getState().setProjectSort(project.id, null);
              sortMenu.close();
            }}
            onPick={(mode) => {
              useLayout.getState().setProjectSort(project.id, mode);
              sortMenu.close();
            }}
          />
        ) : null}
```

Note both `picker` and `sortMenu` want `anchorRef` on the header. `useAnchoredMenu`'s ref is only used for outside-press detection and both popovers anchor to the same header div, so set both refs:

```tsx
      <div
        className="kr-reveal-parent"
        ref={(node: HTMLDivElement | null) => {
          picker.anchorRef.current = node;
          sortMenu.anchorRef.current = node;
        }}
        style={projectHeaderStyle}
      >
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/sidebar/ && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/sidebar/ProjectGroup.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): per-project sort override with follow-global reset"
```

---

### Task 7: Full-suite check and browser QA

**Files:** none new — verification only (fix regressions where they surface).

- [ ] **Step 1: Full check**

Run: `pnpm check`
Expected: format, lint, tsc, all FE tests, Rust suite — green. Fix anything that fails before proceeding.

- [ ] **Step 2: Browser QA** (browser QA): run `pnpm dev` in the background, open `http://localhost:1420` with the Playwright MCP tools, and seed via `window.__kriyon`:

```js
// In browser_evaluate — seed one project with 4 sessions:
const { useSessions } = window.__kriyon;
useSessions.getState().addProject({ color: null, id: 'p1', name: 'demo', path: '/tmp/p1', setupCommand: null });
[['s1','alpha task'],['s2','beta task'],['s3','gamma task'],['s4','delta task']].forEach(([id, title], i) => {
  useSessions.getState().addSession({ archivedAt: null, claudeSessionId: null, createdAt: 100 - i, cwd: '/tmp', id, projectId: 'p1', status: 'idle', summary: '', title, worktreePath: null });
});
```

Verify, screenshotting the sidebar at each step:
1. Sort button menu opens; pick **Name** → rows go alphabetical.
2. Drag `alpha task` below `gamma task` (Playwright: `browser_drag` or pointer down → move >6px → drop on the target row). Row lands and stays; `useLayout.getState().layout.projectSortOverrides.p1` is `"manual"` and `manualSessionOrder.p1` holds the new order.
3. Reload the page, re-seed the same sessions → manual order still applies (persistence; in dev the backend save may be a no-op — if `saveLayout` isn't available without Tauri, verify persistence by asserting the store fields instead and note it).
4. Global sort → **Date** → override cleared, rows newest-first; project header's ↕ icon back to hover-only.
5. Type in the filter box → rows filter, dragging is inert.
6. Row click still selects (no drag hijack); close ×, ⋯ menu, project header buttons all still work.

- [ ] **Step 3: Fine-tune** anything that looks off against the design (spacing, drag ghost opacity) and re-screenshot.

- [ ] **Step 4: Commit any fixes**

```bash
pnpm fix
git add <named files you touched>
git commit -m "fix(sidebar): polish drag-reorder QA findings"
```
