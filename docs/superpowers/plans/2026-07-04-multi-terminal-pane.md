# Multi-terminal pane (Project terminals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run multiple ordinary shell terminals per Project (dev servers, builds, logs) in tabs that can be split into side-by-side/stacked panes, shown in both a bottom dock and a full-height view.

**Architecture:** A new `useTerminals` zustand store owns per-project tabs/panes. One `TerminalWorkspace` component renders tabs + a `react-resizable-panels` grid, mounted in two hosts (bottom `TerminalDock`, full `TerminalView`). Each pane reuses the existing `Terminal` component + `sessionHost`/`create_session` PTY stack unchanged — it simply never calls `launchClaudeOnce`/`watch_transcript`. Backend is untouched.

**Tech Stack:** React 19, zustand 5, xterm.js, `react-resizable-panels@3.0.6`, vitest + @testing-library/react, Tauri v2.

## Global Constraints

- **Design tokens only** — all colors/spacing/radii from `src/theme/tokens.ts`. Never hardcode.
- **Formatting/lint owned by Ultracite/Biome** — run `pnpm fix` before every commit; never hand-format.
- **`pnpm check` must pass before every commit** (typecheck + lint + tests).
- **TDD** — write the failing test first, watch it fail, then implement.
- **Conventional commits**, typed branch (`feat/…`); never commit to `main`.
- **Shared-worktree rule** — stage named files only (`git add <path>`), never `git add -u`/`.`.
- **No process/fs/network in the frontend** — all OS access via existing Tauri commands in `src/ipc/bridge.ts`.
- **Pin** `react-resizable-panels` to exactly `3.0.6` (classic `PanelGroup`/`Panel`/`PanelResizeHandle` API; React-19-compatible).
- **New domain terms** (`Project terminal`, `Terminal tab`, `Terminal pane`, `Terminal workspace`, `Terminal dock`, `Terminal view`) must be added to `CONTEXT.md` before they become type/module names (Task 1).
- **id generation** — `crypto.randomUUID()` (matches `src/state/actions.ts`).
- A Project terminal pane's id is the PTY session id passed to `create_session`; it must be a bare UUID (backend validates it as the socket key).

---

### Task 1: Add dependency + terminology

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `CONTEXT.md` (add terms)

**Interfaces:**
- Produces: the `react-resizable-panels` module (`PanelGroup`, `Panel`, `PanelResizeHandle`) available to later tasks; the canonical term spellings.

- [ ] **Step 1: Add the dependency (pinned, exact version)**

Run:
```bash
pnpm add react-resizable-panels@3.0.6 --save-exact
```
Expected: `package.json` `dependencies` gains `"react-resizable-panels": "3.0.6"` (no `^`).

- [ ] **Step 2: Verify the classic API is importable**

Run:
```bash
node -e "console.log(Object.keys(require('react-resizable-panels')).filter(k=>/Panel/.test(k)))"
```
Expected output includes: `Panel`, `PanelGroup`, `PanelResizeHandle`.

- [ ] **Step 3: Add terms to `CONTEXT.md`**

Add these entries near the existing `Session` / `Project (Workspace)` definitions (match the file's `- **Term** — …` bullet style):

```markdown
- **Project terminal** — a plain login shell the user runs inside a [Project (Workspace)] for
  dev servers, builds, and logs. Reuses a [Session]'s PTY plumbing ([PTY daemon], [Session
  socket], [Daemon client]) but hosts no `claude`: no [Transcript], no [Status], no sidebar
  entry. _Avoid_: "task terminal" (collides with [Task]), "utility session".
- **Terminal tab** — a named group of one or more [Terminal pane]s within one Project.
- **Terminal pane** — one [Project terminal] in a split. Backed by its own [PTY daemon], keyed
  by a fresh Kriyon UUID (same id type a [Session] uses as its socket key).
- **Terminal workspace** — the shared component + store rendering tabs and panes; mounted in
  both the [Terminal dock] and the [Terminal view].
- **Terminal dock** — the resizable bottom-panel host in the workspace center column.
- **Terminal view** — the full-height top-level [Terminal workspace] host in the view switcher.
```

- [ ] **Step 4: Commit**

```bash
pnpm fix
git add package.json pnpm-lock.yaml CONTEXT.md
git commit -m "feat(terminals): add react-resizable-panels and Project-terminal terms"
```

---

### Task 2: `useTerminals` store

**Files:**
- Create: `src/state/terminals.ts`
- Test: `src/state/terminals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TerminalPane { id: string; cwd: string }
  export interface TerminalTab {
    id: string; title: string;
    panes: TerminalPane[]; activePaneId: string;
    direction: "row" | "column";
    layout: number[];           // pane size %s from react-resizable-panels onLayout; [] until first drag
  }
  export interface ProjectTerminals { tabs: TerminalTab[]; activeTabId: string }
  export interface TerminalsState {
    byProject: Record<string, ProjectTerminals>;
    openTab: (projectId: string, cwd: string) => string;           // returns new tab id
    closeTab: (projectId: string, tabId: string) => void;
    renameTab: (projectId: string, tabId: string, title: string) => void;
    setActiveTab: (projectId: string, tabId: string) => void;
    splitPane: (projectId: string, tabId: string, cwd: string) => string; // returns new pane id
    setDirection: (projectId: string, tabId: string, direction: "row" | "column") => void;
    closePane: (projectId: string, tabId: string, paneId: string) => void;
    setActivePane: (projectId: string, tabId: string, paneId: string) => void;
    setLayout: (projectId: string, tabId: string, layout: number[]) => void;
    livePaneCount: () => number;
    hydrate: (byProject: Record<string, ProjectTerminals>) => void;  // for persistence restore
  }
  export const useTerminals: UseBoundStore<StoreApi<TerminalsState>>;
  // Side-effect contract: closePane / closeTab on the LAST pane call disposeSession(paneId)
  //   for every removed pane (tears down that pane's PTY daemon).
  ```
- Consumes: `disposeSession` from `src/terminal/sessionHost.ts`; `crypto.randomUUID()`.

Tab titles auto-number as "Terminal 1", "Terminal 2", … using the count of existing tabs in that project +1 at creation (not reused after close — simplest; duplicates are acceptable and user-renameable).

- [ ] **Step 1: Write the failing test**

Create `src/state/terminals.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispose = vi.fn();
vi.mock("../terminal/sessionHost.ts", () => ({
  disposeSession: (id: string) => dispose(id),
}));

import { useTerminals } from "./terminals.ts";

function reset() {
  useTerminals.setState({ byProject: {} });
  dispose.mockClear();
}

describe("useTerminals", () => {
  beforeEach(reset);

  it("openTab seeds one tab with one pane whose cwd is the project cwd", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const p = useTerminals.getState().byProject.proj;
    expect(p.tabs).toHaveLength(1);
    expect(p.activeTabId).toBe(tabId);
    expect(p.tabs[0].panes).toHaveLength(1);
    expect(p.tabs[0].panes[0].cwd).toBe("/repo");
    expect(p.tabs[0].activePaneId).toBe(p.tabs[0].panes[0].id);
    expect(p.tabs[0].direction).toBe("row");
    expect(p.tabs[0].title).toBe("Terminal 1");
  });

  it("a second openTab numbers Terminal 2 and becomes active", () => {
    useTerminals.getState().openTab("proj", "/repo");
    const t2 = useTerminals.getState().openTab("proj", "/repo");
    const p = useTerminals.getState().byProject.proj;
    expect(p.tabs).toHaveLength(2);
    expect(p.tabs[1].title).toBe("Terminal 2");
    expect(p.activeTabId).toBe(t2);
  });

  it("splitPane adds a pane to the tab and makes it active, preserving others", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().splitPane("proj", tabId, "/repo");
    const tab = useTerminals.getState().byProject.proj.tabs[0];
    expect(tab.panes).toHaveLength(2);
    expect(tab.activePaneId).toBe(paneId);
  });

  it("closePane removes the pane, disposes its daemon, reassigns active", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().splitPane("proj", tabId, "/repo");
    useTerminals.getState().closePane("proj", tabId, paneId);
    const tab = useTerminals.getState().byProject.proj.tabs[0];
    expect(tab.panes).toHaveLength(1);
    expect(tab.activePaneId).toBe(tab.panes[0].id);
    expect(dispose).toHaveBeenCalledWith(paneId);
  });

  it("closing the last pane of a tab closes the tab and disposes the pane", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const onlyPane = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().closePane("proj", tabId, onlyPane);
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(0);
    expect(dispose).toHaveBeenCalledWith(onlyPane);
  });

  it("closeTab disposes every pane in the tab and reassigns active tab", () => {
    const t1 = useTerminals.getState().openTab("proj", "/repo");
    const paneT1 = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().splitPane("proj", t1, "/repo");
    const t2 = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().closeTab("proj", t2);
    const p = useTerminals.getState().byProject.proj;
    expect(p.tabs).toHaveLength(1);
    expect(p.activeTabId).toBe(t1);
    useTerminals.getState().closeTab("proj", t1);
    expect(dispose).toHaveBeenCalledWith(paneT1);
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(0);
  });

  it("renameTab and setDirection mutate the tab", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().renameTab("proj", tabId, "dev");
    useTerminals.getState().setDirection("proj", tabId, "column");
    const tab = useTerminals.getState().byProject.proj.tabs[0];
    expect(tab.title).toBe("dev");
    expect(tab.direction).toBe("column");
  });

  it("livePaneCount counts panes across all projects", () => {
    const a = useTerminals.getState().openTab("a", "/a");
    useTerminals.getState().splitPane("a", a, "/a");
    useTerminals.getState().openTab("b", "/b");
    expect(useTerminals.getState().livePaneCount()).toBe(3);
  });

  it("projects are isolated", () => {
    useTerminals.getState().openTab("a", "/a");
    expect(useTerminals.getState().byProject.b).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/state/terminals.test.ts`
Expected: FAIL — cannot find module `./terminals.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/state/terminals.ts`:

```ts
import { create } from "zustand";
import { disposeSession } from "../terminal/sessionHost.ts";

export interface TerminalPane {
  id: string;
  cwd: string;
}

export interface TerminalTab {
  activePaneId: string;
  direction: "row" | "column";
  id: string;
  /** Pane size percentages from react-resizable-panels `onLayout`; `[]` until first drag. */
  layout: number[];
  panes: TerminalPane[];
  title: string;
}

export interface ProjectTerminals {
  activeTabId: string;
  tabs: TerminalTab[];
}

export interface TerminalsState {
  byProject: Record<string, ProjectTerminals>;
  closePane: (projectId: string, tabId: string, paneId: string) => void;
  closeTab: (projectId: string, tabId: string) => void;
  hydrate: (byProject: Record<string, ProjectTerminals>) => void;
  livePaneCount: () => number;
  openTab: (projectId: string, cwd: string) => string;
  renameTab: (projectId: string, tabId: string, title: string) => void;
  setActivePane: (projectId: string, tabId: string, paneId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  setDirection: (
    projectId: string,
    tabId: string,
    direction: "row" | "column"
  ) => void;
  setLayout: (projectId: string, tabId: string, layout: number[]) => void;
  splitPane: (projectId: string, tabId: string, cwd: string) => string;
}

function newPane(cwd: string): TerminalPane {
  return { cwd, id: crypto.randomUUID() };
}

function newTab(title: string, cwd: string): TerminalTab {
  const pane = newPane(cwd);
  return {
    activePaneId: pane.id,
    direction: "row",
    id: crypto.randomUUID(),
    layout: [],
    panes: [pane],
    title,
  };
}

/** Apply `fn` to one project's tab and return a new byProject map (immutable). */
function updateTab(
  byProject: Record<string, ProjectTerminals>,
  projectId: string,
  tabId: string,
  fn: (tab: TerminalTab) => TerminalTab
): Record<string, ProjectTerminals> {
  const project = byProject[projectId];
  if (!project) {
    return byProject;
  }
  return {
    ...byProject,
    [projectId]: {
      ...project,
      tabs: project.tabs.map((t) => (t.id === tabId ? fn(t) : t)),
    },
  };
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  byProject: {},

  openTab: (projectId, cwd) => {
    const project = get().byProject[projectId];
    const title = `Terminal ${(project?.tabs.length ?? 0) + 1}`;
    const tab = newTab(title, cwd);
    set((state) => {
      const existing = state.byProject[projectId];
      return {
        byProject: {
          ...state.byProject,
          [projectId]: {
            activeTabId: tab.id,
            tabs: [...(existing?.tabs ?? []), tab],
          },
        },
      };
    });
    return tab.id;
  },

  closeTab: (projectId, tabId) => {
    const project = get().byProject[projectId];
    const tab = project?.tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    for (const pane of tab.panes) {
      disposeSession(pane.id);
    }
    set((state) => {
      const p = state.byProject[projectId];
      if (!p) {
        return state;
      }
      const tabs = p.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        p.activeTabId === tabId ? (tabs.at(-1)?.id ?? "") : p.activeTabId;
      return {
        byProject: { ...state.byProject, [projectId]: { activeTabId, tabs } },
      };
    });
  },

  renameTab: (projectId, tabId, title) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        title,
      })),
    })),

  setActiveTab: (projectId, tabId) =>
    set((state) => {
      const p = state.byProject[projectId];
      if (!p) {
        return state;
      }
      return {
        byProject: {
          ...state.byProject,
          [projectId]: { ...p, activeTabId: tabId },
        },
      };
    }),

  splitPane: (projectId, tabId, cwd) => {
    const pane = newPane(cwd);
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        activePaneId: pane.id,
        layout: [],
        panes: [...t.panes, pane],
      })),
    }));
    return pane.id;
  },

  setDirection: (projectId, tabId, direction) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        direction,
      })),
    })),

  closePane: (projectId, tabId, paneId) => {
    const project = get().byProject[projectId];
    const tab = project?.tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    disposeSession(paneId);
    if (tab.panes.length <= 1) {
      get().closeTab(projectId, tabId);
      return;
    }
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => {
        const panes = t.panes.filter((pane) => pane.id !== paneId);
        const activePaneId =
          t.activePaneId === paneId
            ? (panes.at(-1)?.id ?? "")
            : t.activePaneId;
        return { ...t, activePaneId, layout: [], panes };
      }),
    }));
  },

  setActivePane: (projectId, tabId, paneId) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        activePaneId: paneId,
      })),
    })),

  setLayout: (projectId, tabId, layout) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        layout,
      })),
    })),

  livePaneCount: () =>
    Object.values(get().byProject).reduce(
      (sum, p) => sum + p.tabs.reduce((n, t) => n + t.panes.length, 0),
      0
    ),

  hydrate: (byProject) => set({ byProject }),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/state/terminals.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/terminals.ts src/state/terminals.test.ts
git commit -m "feat(terminals): add useTerminals store for per-project tabs and panes"
```

---

### Task 3: `TerminalPaneView` — one pane wrapping the existing Terminal

**Files:**
- Create: `src/terminal/TerminalPaneView.tsx`
- Test: `src/terminal/TerminalPaneView.test.tsx`

**Interfaces:**
- Consumes: `Terminal` (`src/terminal/Terminal.tsx`, props `{ active?, cwd, sessionId }`); `useTerminals`.
- Produces:
  ```ts
  export function TerminalPaneView(props: {
    active: boolean;        // this pane is the active pane of a visible tab
    cwd: string;
    onClose: () => void;
    onSplit: () => void;
    onFocus: () => void;
    paneId: string;
    showControls: boolean;  // hide split/close when the tab has a single pane and controls live on the tab strip
  }): JSX.Element
  ```
- Renders a per-pane header (cwd basename, split ⿲, close ×) above `<Terminal active cwd sessionId={paneId} />`. `active` is passed straight to `Terminal` — this is the WebGL gate; only visible active panes hold a WebGL context. Because `Terminal` never calls `launchClaudeOnce`, the pane is a plain shell.

The header uses `tokens` for all styling (mirror the compact header style in `src/layout/SessionHeader.tsx` for reference).

- [ ] **Step 1: Write the failing test**

Create `src/terminal/TerminalPaneView.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Terminal.tsx", () => ({
  Terminal: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div data-active={active} data-testid={`term-${sessionId}`} />
  ),
}));

import { TerminalPaneView } from "./TerminalPaneView.tsx";

describe("TerminalPaneView", () => {
  it("renders the Terminal with the pane id and forwards active", () => {
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={vi.fn()}
        onFocus={vi.fn()}
        onSplit={vi.fn()}
        paneId="pane-1"
        showControls
      />
    );
    const term = screen.getByTestId("term-pane-1");
    expect(term.getAttribute("data-active")).toBe("true");
  });

  it("fires onSplit and onClose from the header controls", () => {
    const onSplit = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={onClose}
        onFocus={vi.fn()}
        onSplit={onSplit}
        paneId="pane-1"
        showControls
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /split/i }));
    fireEvent.click(screen.getByRole("button", { name: /close pane/i }));
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides controls when showControls is false", () => {
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={vi.fn()}
        onFocus={vi.fn()}
        onSplit={vi.fn()}
        paneId="pane-1"
        showControls={false}
      />
    );
    expect(screen.queryByRole("button", { name: /split/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/terminal/TerminalPaneView.test.tsx`
Expected: FAIL — cannot find `./TerminalPaneView.tsx`.

- [ ] **Step 3: Write minimal implementation**

Create `src/terminal/TerminalPaneView.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";
import { Terminal } from "./Terminal.tsx";

const wrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  minWidth: 0,
};

const headerStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.surface.s2,
  borderBottom: `1px solid ${tokens.color.line.base}`,
  color: tokens.color.ink.muted,
  display: "flex",
  flex: "0 0 auto",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  gap: "6px",
  height: "24px",
  padding: "0 6px",
};

const ctlStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.faint,
  cursor: "pointer",
  display: "flex",
  fontSize: "12px",
  height: "18px",
  justifyContent: "center",
  padding: 0,
  width: "18px",
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function TerminalPaneView({
  active,
  cwd,
  onClose,
  onFocus,
  onSplit,
  paneId,
  showControls,
}: {
  active: boolean;
  cwd: string;
  onClose: () => void;
  onFocus: () => void;
  onSplit: () => void;
  paneId: string;
  showControls: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: focus-on-click only; keyboard focus lands via the terminal.
    <div
      onMouseDown={onFocus}
      style={{
        ...wrapStyle,
        outline: active
          ? `1px solid ${tokens.color.line.strong}`
          : "1px solid transparent",
      }}
    >
      <div style={headerStyle}>
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}
          title={cwd}
        >
          {basename(cwd)}
        </span>
        {showControls ? (
          <>
            <button
              aria-label="Split pane"
              className="kr-hover-surface"
              onClick={onSplit}
              style={ctlStyle}
              title="Split pane"
              type="button"
            >
              ⿲
            </button>
            <button
              aria-label="Close pane"
              className="kr-hover-surface"
              onClick={onClose}
              style={ctlStyle}
              title="Close pane"
              type="button"
            >
              ×
            </button>
          </>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <Terminal active={active} cwd={cwd} sessionId={paneId} />
      </div>
    </div>
  );
}
```

> Note: if `tokens.radius.sm` does not exist, use `tokens.radius.md`. Verify against `src/theme/tokens.ts` and use the smallest available radius token.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/terminal/TerminalPaneView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/terminal/TerminalPaneView.tsx src/terminal/TerminalPaneView.test.tsx
git commit -m "feat(terminals): add TerminalPaneView wrapping the shared Terminal"
```

---

### Task 4: `TabPaneGrid` — split layout of a tab's panes

**Files:**
- Create: `src/terminal/TabPaneGrid.tsx`
- Test: `src/terminal/TabPaneGrid.test.tsx`

**Interfaces:**
- Consumes: `TerminalPaneView` (Task 3); `TerminalTab` (Task 2); `react-resizable-panels` (`PanelGroup`, `Panel`, `PanelResizeHandle`).
- Produces:
  ```ts
  export function TabPaneGrid(props: {
    tab: TerminalTab;
    visible: boolean;           // the whole workspace host is visible AND this is the active tab
    onSplitPane: (paneId: string) => void;
    onClosePane: (paneId: string) => void;
    onFocusPane: (paneId: string) => void;
    onLayout: (sizes: number[]) => void;
  }): JSX.Element
  ```
- A pane is `active` (WebGL) when `visible && pane.id === tab.activePaneId`. Single-pane tabs render one `TerminalPaneView` without resize handles; multi-pane tabs render a `PanelGroup` with `direction={tab.direction === "row" ? "horizontal" : "vertical"}`, a `Panel` per pane, and `PanelResizeHandle`s between them. `onLayout` persists sizes.

Mock `react-resizable-panels` in the test to keep it deterministic.

- [ ] **Step 1: Write the failing test**

Create `src/terminal/TabPaneGrid.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "../state/terminals.ts";

vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelGroup: ({
    children,
    direction,
  }: {
    children: React.ReactNode;
    direction: string;
  }) => <div data-direction={direction}>{children}</div>,
  PanelResizeHandle: () => <div data-testid="resize-handle" />,
}));

vi.mock("./TerminalPaneView.tsx", () => ({
  TerminalPaneView: ({ paneId, active }: { paneId: string; active: boolean }) => (
    <div data-active={active} data-testid={`pane-${paneId}`} />
  ),
}));

import { TabPaneGrid } from "./TabPaneGrid.tsx";

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    activePaneId: "p1",
    direction: "row",
    id: "t1",
    layout: [],
    panes: [{ cwd: "/r", id: "p1" }],
    title: "Terminal 1",
    ...overrides,
  };
}

const noop = () => {
  /* no-op */
};

describe("TabPaneGrid", () => {
  it("renders a single pane without resize handles", () => {
    render(
      <TabPaneGrid
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onSplitPane={noop}
        tab={tab()}
        visible
      />
    );
    expect(screen.getByTestId("pane-p1")).toBeTruthy();
    expect(screen.queryByTestId("resize-handle")).toBeNull();
  });

  it("renders a PanelGroup with a handle between two panes and maps direction", () => {
    render(
      <TabPaneGrid
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onSplitPane={noop}
        tab={tab({
          direction: "column",
          panes: [
            { cwd: "/r", id: "p1" },
            { cwd: "/r", id: "p2" },
          ],
        })}
        visible
      />
    );
    expect(screen.getByTestId("pane-p1")).toBeTruthy();
    expect(screen.getByTestId("pane-p2")).toBeTruthy();
    expect(screen.getAllByTestId("resize-handle")).toHaveLength(1);
    expect(screen.getByText("", { selector: "[data-direction=vertical]" })).toBeTruthy();
  });

  it("marks only the active pane active when visible", () => {
    render(
      <TabPaneGrid
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onSplitPane={noop}
        tab={tab({
          activePaneId: "p2",
          panes: [
            { cwd: "/r", id: "p1" },
            { cwd: "/r", id: "p2" },
          ],
        })}
        visible
      />
    );
    expect(screen.getByTestId("pane-p1").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("pane-p2").getAttribute("data-active")).toBe("true");
  });

  it("marks no pane active when not visible", () => {
    render(
      <TabPaneGrid
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onSplitPane={noop}
        tab={tab()}
        visible={false}
      />
    );
    expect(screen.getByTestId("pane-p1").getAttribute("data-active")).toBe("false");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/terminal/TabPaneGrid.test.tsx`
Expected: FAIL — cannot find `./TabPaneGrid.tsx`.

- [ ] **Step 3: Write minimal implementation**

Create `src/terminal/TabPaneGrid.tsx`:

```tsx
import { Fragment } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { CSSProperties } from "react";
import type { TerminalTab } from "../state/terminals.ts";
import { tokens } from "../theme/tokens.ts";
import { TerminalPaneView } from "./TerminalPaneView.tsx";

const handleStyleRow: CSSProperties = {
  background: tokens.color.line.base,
  cursor: "col-resize",
  flex: "0 0 3px",
};

const handleStyleColumn: CSSProperties = {
  background: tokens.color.line.base,
  cursor: "row-resize",
  flex: "0 0 3px",
};

export function TabPaneGrid({
  onClosePane,
  onFocusPane,
  onLayout,
  onSplitPane,
  tab,
  visible,
}: {
  onClosePane: (paneId: string) => void;
  onFocusPane: (paneId: string) => void;
  onLayout: (sizes: number[]) => void;
  onSplitPane: (paneId: string) => void;
  tab: TerminalTab;
  visible: boolean;
}) {
  const single = tab.panes.length === 1;

  if (single) {
    const pane = tab.panes[0];
    return (
      <div style={{ height: "100%" }}>
        <TerminalPaneView
          active={visible}
          cwd={pane.cwd}
          onClose={() => onClosePane(pane.id)}
          onFocus={() => onFocusPane(pane.id)}
          onSplit={() => onSplitPane(pane.id)}
          paneId={pane.id}
          showControls={false}
        />
      </div>
    );
  }

  const handleStyle = tab.direction === "row" ? handleStyleRow : handleStyleColumn;

  return (
    <PanelGroup
      direction={tab.direction === "row" ? "horizontal" : "vertical"}
      onLayout={onLayout}
    >
      {tab.panes.map((pane, i) => (
        <Fragment key={pane.id}>
          {i > 0 ? <PanelResizeHandle style={handleStyle} /> : null}
          <Panel
            defaultSize={tab.layout[i] ?? 100 / tab.panes.length}
            minSize={10}
          >
            <TerminalPaneView
              active={visible && pane.id === tab.activePaneId}
              cwd={pane.cwd}
              onClose={() => onClosePane(pane.id)}
              onFocus={() => onFocusPane(pane.id)}
              onSplit={() => onSplitPane(pane.id)}
              paneId={pane.id}
              showControls
            />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/terminal/TabPaneGrid.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/terminal/TabPaneGrid.tsx src/terminal/TabPaneGrid.test.tsx
git commit -m "feat(terminals): add TabPaneGrid split layout via react-resizable-panels"
```

---

### Task 5: `TerminalWorkspace` — tab strip + active tab grid

**Files:**
- Create: `src/terminal/TerminalWorkspace.tsx`
- Test: `src/terminal/TerminalWorkspace.test.tsx`

**Interfaces:**
- Consumes: `useTerminals` (Task 2); `TabPaneGrid` (Task 4).
- Produces:
  ```ts
  export function TerminalWorkspace(props: {
    projectId: string | null;   // active project; null => empty state
    cwd: string;                // default cwd for new tabs/panes (project root)
    visible: boolean;           // host (dock/view) is visible
  }): JSX.Element
  ```
- Renders: a tab strip (each tab: click to activate, double-click to rename inline, × to close; trailing `+` opens a tab) and the active tab's `TabPaneGrid`. Wires all callbacks to `useTerminals` actions. Split direction control (↔/↕) toggles `setDirection` on the active tab. When `projectId` is null or has no tabs, shows an empty state with a "New terminal" button (disabled when null).

- [ ] **Step 1: Write the failing test**

Create `src/terminal/TerminalWorkspace.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./TabPaneGrid.tsx", () => ({
  TabPaneGrid: ({ tab }: { tab: { id: string } }) => (
    <div data-testid={`grid-${tab.id}`} />
  ),
}));

import { useTerminals } from "../state/terminals.ts";
import { TerminalWorkspace } from "./TerminalWorkspace.tsx";

// disposeSession is called by the store; stub it so tests don't hit IPC.
vi.mock("../terminal/sessionHost.ts", () => ({ disposeSession: vi.fn() }));

beforeEach(() => useTerminals.setState({ byProject: {} }));

describe("TerminalWorkspace", () => {
  it("empty state offers a New terminal button that opens a tab", () => {
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: /new terminal/i }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(1);
  });

  it("renders a tab per tab and the active grid", () => {
    const id = useTerminals.getState().openTab("proj", "/repo");
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    expect(screen.getByTestId(`grid-${id}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Terminal 1/ })).toBeTruthy();
  });

  it("the + button adds a tab", () => {
    useTerminals.getState().openTab("proj", "/repo");
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: /new terminal tab/i }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(2);
  });

  it("shows a disabled state when projectId is null", () => {
    render(<TerminalWorkspace cwd="" projectId={null} visible />);
    expect(
      screen.getByRole("button", { name: /new terminal/i })
    ).toHaveProperty("disabled", true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/terminal/TerminalWorkspace.test.tsx`
Expected: FAIL — cannot find `./TerminalWorkspace.tsx`.

- [ ] **Step 3: Write minimal implementation**

Create `src/terminal/TerminalWorkspace.tsx`. Requirements (write complete code mirroring `tokens` styling from `src/layout/Shell.tsx`'s `TitleBar` for the strip):

- Subscribe: `const project = useTerminals((s) => (projectId ? s.byProject[projectId] : undefined))`.
- Actions via `useTerminals.getState()` inside handlers (or select each action).
- Tab strip: `project?.tabs.map(...)` → a button labelled by `tab.title` (accessible name must include the title so the test's `name: /Terminal 1/` matches), active style when `tab.id === project.activeTabId`, onClick `setActiveTab`, a small × calling `closeTab`. Double-click swaps the label for a controlled `<input>` that calls `renameTab` on blur/Enter.
- Trailing button: `aria-label="New terminal tab"`, onClick `openTab(projectId, cwd)`.
- Direction toggle button for the active tab: label `↔`/`↕`, onClick `setDirection(projectId, activeTabId, dir === "row" ? "column" : "row")`.
- Body: if no `project` or `project.tabs.length === 0`, render an empty state with a button `aria-label="New terminal"` (disabled when `projectId === null`) calling `openTab`. Else render `TabPaneGrid` for the active tab with:
  - `visible={visible}`
  - `onSplitPane={(paneId) => splitPane(projectId, activeTab.id, activeTab.panes.find(p=>p.id===paneId)?.cwd ?? cwd)}`
  - `onClosePane={(paneId) => closePane(projectId, activeTab.id, paneId)}`
  - `onFocusPane={(paneId) => setActivePane(projectId, activeTab.id, paneId)}`
  - `onLayout={(sizes) => setLayout(projectId, activeTab.id, sizes)}`

Full reference implementation:

```tsx
import { type CSSProperties, useState } from "react";
import { tokens } from "../theme/tokens.ts";
import { useTerminals } from "../state/terminals.ts";
import { TabPaneGrid } from "./TabPaneGrid.tsx";

const stripStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.surface.s2,
  borderBottom: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flex: "0 0 auto",
  gap: "2px",
  height: "30px",
  padding: "0 6px",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    background: active ? tokens.color.surface.hover : "transparent",
    border: "none",
    borderRadius: tokens.radius.md,
    color: active ? tokens.color.ink.bright : tokens.color.ink.muted,
    cursor: "pointer",
    fontFamily: tokens.font.sans,
    fontSize: "12px",
    padding: "4px 8px",
  };
}

const addStyle: CSSProperties = {
  ...tabStyle(false),
  fontSize: "15px",
  padding: "2px 8px",
};

const emptyStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.textMuted,
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  height: "100%",
  justifyContent: "center",
};

export function TerminalWorkspace({
  cwd,
  projectId,
  visible,
}: {
  cwd: string;
  projectId: string | null;
  visible: boolean;
}) {
  const project = useTerminals((s) =>
    projectId ? s.byProject[projectId] : undefined
  );
  const [editing, setEditing] = useState<string | null>(null);

  const t = useTerminals.getState();
  const activeTab = project?.tabs.find((tab) => tab.id === project.activeTabId);

  const empty = !(projectId && project && project.tabs.length > 0);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div style={stripStyle}>
        {project?.tabs.map((tab) => {
          const isActive = tab.id === project.activeTabId;
          if (editing === tab.id) {
            return (
              <input
                autoFocus
                defaultValue={tab.title}
                key={tab.id}
                onBlur={(e) => {
                  if (projectId) {
                    t.renameTab(projectId, tab.id, e.target.value || tab.title);
                  }
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                style={{ ...tabStyle(true), width: "88px" }}
              />
            );
          }
          return (
            <span key={tab.id} style={{ alignItems: "center", display: "flex" }}>
              <button
                onClick={() => projectId && t.setActiveTab(projectId, tab.id)}
                onDoubleClick={() => setEditing(tab.id)}
                style={tabStyle(isActive)}
                type="button"
              >
                {tab.title}
              </button>
              <button
                aria-label={`Close ${tab.title}`}
                className="kr-hover-surface"
                onClick={() => projectId && t.closeTab(projectId, tab.id)}
                style={{ ...tabStyle(false), padding: "2px 4px" }}
                type="button"
              >
                ×
              </button>
            </span>
          );
        })}
        {projectId ? (
          <button
            aria-label="New terminal tab"
            className="kr-hover-surface"
            onClick={() => t.openTab(projectId, cwd)}
            style={addStyle}
            type="button"
          >
            +
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        {activeTab && projectId ? (
          <button
            aria-label="Toggle split direction"
            className="kr-hover-surface"
            onClick={() =>
              t.setDirection(
                projectId,
                activeTab.id,
                activeTab.direction === "row" ? "column" : "row"
              )
            }
            style={addStyle}
            title="Toggle split direction"
            type="button"
          >
            {activeTab.direction === "row" ? "↔" : "↕"}
          </button>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {empty || !(activeTab && projectId) ? (
          <div style={emptyStyle}>
            <span>No terminals in this project yet.</span>
            <button
              aria-label="New terminal"
              className="kr-hover-surface"
              disabled={projectId === null}
              onClick={() => projectId && t.openTab(projectId, cwd)}
              style={tabStyle(true)}
              type="button"
            >
              New terminal
            </button>
          </div>
        ) : (
          <TabPaneGrid
            onClosePane={(paneId) =>
              t.closePane(projectId, activeTab.id, paneId)
            }
            onFocusPane={(paneId) =>
              t.setActivePane(projectId, activeTab.id, paneId)
            }
            onLayout={(sizes) => t.setLayout(projectId, activeTab.id, sizes)}
            onSplitPane={(paneId) =>
              t.splitPane(
                projectId,
                activeTab.id,
                activeTab.panes.find((p) => p.id === paneId)?.cwd ?? cwd
              )
            }
            tab={activeTab}
            visible={visible}
          />
        )}
      </div>
    </div>
  );
}
```

> Verify `tokens.color.surface.hover`, `tokens.color.textMuted`, `tokens.radius.md`, `tokens.font.sans` exist (they are used in `Shell.tsx`). Adjust to the nearest existing token if any differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/terminal/TerminalWorkspace.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/terminal/TerminalWorkspace.tsx src/terminal/TerminalWorkspace.test.tsx
git commit -m "feat(terminals): add TerminalWorkspace tab strip and grid host"
```

---

### Task 6: Layout store — dock state + terminals view

**Files:**
- Modify: `src/state/layout.ts`
- Modify: `src/state/persistence.ts:38-50,68-86` (add view to `LAYOUT_VIEWS`, persist new fields)
- Test: `src/state/layout.test.ts` (extend)

**Interfaces:**
- Produces on `Layout`: `terminalDockOpen: boolean`, `terminalDockHeight: number`, and `view` union gains `"terminals"`.
- Produces on `LayoutState`: `toggleTerminalDock: () => void`, `setTerminalDockHeight: (h: number) => void`.
- Consumes: existing layout patterns.

- [ ] **Step 1: Write the failing test** — append to `src/state/layout.test.ts`:

```ts
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";

it("toggleTerminalDock flips the dock open flag", () => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  expect(useLayout.getState().layout.terminalDockOpen).toBe(false);
  useLayout.getState().toggleTerminalDock();
  expect(useLayout.getState().layout.terminalDockOpen).toBe(true);
});

it("setTerminalDockHeight clamps within [120, 640]", () => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useLayout.getState().setTerminalDockHeight(40);
  expect(useLayout.getState().layout.terminalDockHeight).toBe(120);
  useLayout.getState().setTerminalDockHeight(9000);
  expect(useLayout.getState().layout.terminalDockHeight).toBe(640);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/state/layout.test.ts`
Expected: FAIL — `terminalDockOpen`/`toggleTerminalDock` undefined.

- [ ] **Step 3: Implement in `src/state/layout.ts`**

- Add to `Layout`:
```ts
  /** Bottom Project-terminal dock is open. */
  terminalDockOpen: boolean;
  /** Terminal dock height in px, user-resizable within the clamp range. */
  terminalDockHeight: number;
```
- Change `view` union to: `view: "studio" | "focus" | "command" | "prompts" | "terminals";`
- Add constants + clamp:
```ts
export const TERMINAL_DOCK_HEIGHT_DEFAULT = 260;
export const TERMINAL_DOCK_HEIGHT_MIN = 120;
export const TERMINAL_DOCK_HEIGHT_MAX = 640;
export function clampTerminalDockHeight(h: number): number {
  return Math.min(
    TERMINAL_DOCK_HEIGHT_MAX,
    Math.max(TERMINAL_DOCK_HEIGHT_MIN, h)
  );
}
```
- Add to `DEFAULT_LAYOUT`: `terminalDockOpen: false, terminalDockHeight: TERMINAL_DOCK_HEIGHT_DEFAULT,`
- Add to `LayoutState` interface and the store:
```ts
  toggleTerminalDock: () =>
    set((state) => ({
      layout: { ...state.layout, terminalDockOpen: !state.layout.terminalDockOpen },
    })),
  setTerminalDockHeight: (height) =>
    set((state) => ({
      layout: {
        ...state.layout,
        terminalDockHeight: clampTerminalDockHeight(height),
      },
    })),
```

- [ ] **Step 4: Update persistence in `src/state/persistence.ts`**

- Add `"terminals"` to `LAYOUT_VIEWS`.
- In `parseLayout`'s returned object add:
```ts
    terminalDockOpen: parsed.terminalDockOpen === true,
    terminalDockHeight:
      typeof parsed.terminalDockHeight === "number"
        ? clampTerminalDockHeight(parsed.terminalDockHeight)
        : TERMINAL_DOCK_HEIGHT_DEFAULT,
```
- Import `clampTerminalDockHeight, TERMINAL_DOCK_HEIGHT_DEFAULT` from `./layout.ts`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/state/layout.test.ts src/state/persistence.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add src/state/layout.ts src/state/layout.test.ts src/state/persistence.ts
git commit -m "feat(terminals): add terminal dock state and terminals view to layout"
```

---

### Task 7: Persist terminal structure per project

**Files:**
- Modify: `src/state/persistence.ts` (add a `terminals` blob save/restore)
- Test: `src/state/persistence.test.ts` (extend)

**Interfaces:**
- Consumes: `useTerminals` (Task 2) — its `byProject` and `hydrate`; `saveLayout`/`loadLayout` (`src/ipc/bridge.ts`) with key `"terminals"`.
- Produces: on `hydrate()`, `useTerminals.hydrate(parsed)` restores tab/pane structure (panes re-spawn fresh shells on mount); `installPersistence` also subscribes to `useTerminals` and saves `byProject` (debounced) under key `"terminals"`.

Design note (die-on-quit): panes persist their **structure** (ids, cwds, titles, direction, layout); the live processes are killed on quit (Task 8). Restored pane ids are fresh-shell keys on next launch.

- [ ] **Step 1: Write the failing test** — append to `src/state/persistence.test.ts`:

```ts
// (Reuse the file's existing bridge mock; ensure loadLayout can return a terminals blob
//  and saveLayout is a spy. If the existing mock keys off the argument, extend it to
//  resolve the "terminals" key to the injected JSON.)
it("hydrate restores persisted terminals into useTerminals", async () => {
  const blob = JSON.stringify({
    proj: {
      activeTabId: "t1",
      tabs: [
        {
          activePaneId: "p1",
          direction: "row",
          id: "t1",
          layout: [],
          panes: [{ cwd: "/repo", id: "p1" }],
          title: "dev",
        },
      ],
    },
  });
  // Arrange loadLayout("terminals") => blob (see mock note above), then:
  await hydrate();
  expect(useTerminals.getState().byProject.proj.tabs[0].title).toBe("dev");
});
```

> Implementer: match the existing mock shape in `persistence.test.ts`. If it mocks `loadLayout` to a single value, switch it to a `key`-aware `vi.fn((key) => key === "terminals" ? Promise.resolve(blob) : Promise.resolve(layoutJson))`. Import `useTerminals` and `hydrate`.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/state/persistence.test.ts`
Expected: FAIL — terminals not restored.

- [ ] **Step 3: Implement**

In `src/state/persistence.ts`:
- Add `const TERMINALS_KEY = "terminals";` and import `useTerminals, type ProjectTerminals` from `./terminals.ts`.
- Add a validator:
```ts
function parseTerminals(json: string | null): Record<string, ProjectTerminals> | undefined {
  if (!json) {
    return;
  }
  try {
    const parsed = JSON.parse(json) as Record<string, ProjectTerminals>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return;
  }
}
```
- In `hydrate`, add `loadLayout(TERMINALS_KEY)` to the `Promise.all`, parse it, and call `useTerminals.getState().hydrate(parsed)` when present.
- In `installPersistence`, add a `useTerminals.subscribe` that debounces `saveLayout(TERMINALS_KEY, JSON.stringify(state.byProject))` (mirror the layout subscription), and add its teardown to the returned cleanup.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat(terminals): persist and restore per-project terminal structure"
```

---

### Task 8: Die-on-quit — close Project-terminal daemons on app quit

**Files:**
- Create: `src/terminal/closeOnQuit.ts`
- Test: `src/terminal/closeOnQuit.test.ts`
- Modify: `src/App.tsx` (install the listener in the mount effect)

**Interfaces:**
- Consumes: `useTerminals` (`byProject`), `disposeSession` (`sessionHost.ts`), Tauri window `onCloseRequested` (`@tauri-apps/api/window`), `isTauriRuntime` (`src/ipc/bridge.ts`).
- Produces:
  ```ts
  export function closeAllProjectTerminals(): void  // dispose every pane across all projects
  export function installCloseOnQuit(): () => void  // wire window close-requested -> closeAllProjectTerminals; returns unlisten
  ```

Rationale (from spec): `onCloseRequested` fires on real quit but not on webview reload, which is exactly the reload-survives / quit-kills distinction. On reload, daemons survive and reattach.

- [ ] **Step 1: Write the failing test**

Create `src/terminal/closeOnQuit.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispose = vi.fn();
vi.mock("./sessionHost.ts", () => ({ disposeSession: (id: string) => dispose(id) }));

import { useTerminals } from "../state/terminals.ts";
import { closeAllProjectTerminals } from "./closeOnQuit.ts";

beforeEach(() => {
  useTerminals.setState({ byProject: {} });
  dispose.mockClear();
});

describe("closeAllProjectTerminals", () => {
  it("disposes every pane across all projects", () => {
    const a = useTerminals.getState().openTab("a", "/a");
    useTerminals.getState().splitPane("a", a, "/a");
    useTerminals.getState().openTab("b", "/b");
    dispose.mockClear(); // ignore any dispose from store setup
    closeAllProjectTerminals();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/terminal/closeOnQuit.test.ts`
Expected: FAIL — cannot find `./closeOnQuit.ts`.

- [ ] **Step 3: Implement**

Create `src/terminal/closeOnQuit.ts`:

```ts
import { isTauriRuntime } from "../ipc/bridge.ts";
import { useTerminals } from "../state/terminals.ts";
import { disposeSession } from "./sessionHost.ts";

/** Dispose every Project-terminal pane's PTY daemon across all projects. */
export function closeAllProjectTerminals(): void {
  const { byProject } = useTerminals.getState();
  for (const project of Object.values(byProject)) {
    for (const tab of project.tabs) {
      for (const pane of tab.panes) {
        disposeSession(pane.id);
      }
    }
  }
}

/**
 * Kill Project-terminal daemons on real app quit (window close), NOT on webview
 * reload — `onCloseRequested` fires only on the former, which is exactly the
 * reload-survives / quit-kills distinction Project terminals want. Claude
 * Session daemons deliberately survive quit and are untouched here.
 */
export function installCloseOnQuit(): () => void {
  if (!isTauriRuntime()) {
    return () => {
      // No Tauri runtime (browser QA): nothing to unlisten.
    };
  }
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested(() => {
        closeAllProjectTerminals();
      })
    )
    .then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch(() => {
      // Non-fatal: worst case daemons are cleaned up on next launch.
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/terminal/closeOnQuit.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/App.tsx`**

In the mount `useEffect` (the one at `App.tsx:112-129`), add the install alongside the others:
```ts
import { installCloseOnQuit } from "./terminal/closeOnQuit.ts";
// ...
const stopCloseOnQuit = installCloseOnQuit();
// ...in cleanup:
stopCloseOnQuit();
```

- [ ] **Step 6: Run typecheck + tests**

Run: `pnpm vitest run src/terminal/closeOnQuit.test.ts && pnpm tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 7: Commit**

```bash
pnpm fix
git add src/terminal/closeOnQuit.ts src/terminal/closeOnQuit.test.ts src/App.tsx
git commit -m "feat(terminals): kill Project-terminal daemons on app quit"
```

---

### Task 9: `TerminalDock` host + Shell wiring + indicator

**Files:**
- Create: `src/layout/TerminalDock.tsx`
- Modify: `src/layout/Shell.tsx` (mount dock in `StudioBody` center column; add a title-bar terminal toggle + indicator; add `"terminals"` to the `Segmented` options and a `view === "terminals"` branch)
- Test: `src/layout/TerminalDock.test.tsx`

**Interfaces:**
- Consumes: `useLayout` (`terminalDockOpen`, `terminalDockHeight`, `toggleTerminalDock`, `setTerminalDockHeight`), `useSessions` (active project + cwd), `useTerminals` (`livePaneCount` for the indicator), `TerminalWorkspace`.
- Produces: `export function TerminalDock(): JSX.Element | null` — renders nothing when closed; when open, a bottom panel of height `terminalDockHeight` with a top drag handle (reuse the `ResizeHandle` drag pattern from `src/sidebar/ResizeHandle.tsx`, vertical axis) and `TerminalWorkspace` inside.

Active project + cwd derivation (mirror `FocusBody`):
```ts
const activeSessionId = useSessions((s) => s.activeSessionId);
const sessions = useSessions((s) => s.sessions);
const projects = useSessions((s) => s.projects);
const projectId = activeSessionId ? sessions[activeSessionId]?.projectId ?? null : null;
const cwd = projects.find((p) => p.id === projectId)?.path ?? "";
```

- [ ] **Step 1: Write the failing test**

Create `src/layout/TerminalDock.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalWorkspace.tsx", () => ({
  TerminalWorkspace: ({ projectId }: { projectId: string | null }) => (
    <div data-testid="workspace" data-project={projectId ?? "none"} />
  ),
}));

import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { TerminalDock } from "./TerminalDock.tsx";

beforeEach(() => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
});

describe("TerminalDock", () => {
  it("renders nothing when the dock is closed", () => {
    const { container } = render(<TerminalDock />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the workspace when the dock is open", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    render(<TerminalDock />);
    expect(screen.getByTestId("workspace")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/layout/TerminalDock.test.tsx`
Expected: FAIL — cannot find `./TerminalDock.tsx`.

- [ ] **Step 3: Implement `TerminalDock`**

Create `src/layout/TerminalDock.tsx` — returns `null` when `!terminalDockOpen`; else a `div` of `height: terminalDockHeight`, `borderTop`, containing a vertical drag handle at the top (on drag, call `setTerminalDockHeight(startHeight + (startY - e.clientY))` — dragging up grows the dock) and `<TerminalWorkspace cwd={cwd} projectId={projectId} visible />`. Use `tokens` for styling; model the drag handler on `src/sidebar/ResizeHandle.tsx` (read it) but for the vertical axis with `cursor: "row-resize"`.

- [ ] **Step 4: Wire into `Shell.tsx`**

- In `StudioBody`, inside `centerStyle`, place `<TerminalDock />` **between** `<div style={contentStyle}>…</div>` and `<PromptBar />` so it docks at the bottom of the working column. Because `contentStyle` has `flex: 1` and the dock has a fixed height, the Claude view shrinks and the dock sits below it.
- In `TitleBar`, add a terminal toggle button (before the About button) with the live indicator:
```tsx
const dockOpen = useLayout((s) => s.layout.terminalDockOpen);
const toggleDock = useLayout((s) => s.toggleTerminalDock);
const paneCount = useTerminals((s) => s.livePaneCount());
// ...button labelled "Terminals", onClick toggleDock, showing a "● {paneCount}" badge when paneCount > 0.
```
  Import `useTerminals`. Only show the toggle where the dock exists: gate on `view === "studio"` like the other panel toggles, OR show it in all views (the indicator is global) — show it always; it's the global affordance.
- In the `Segmented` options array add `{ label: "Terminals", value: "terminals" }`.
- In `Shell`, add a branch: `{view === "terminals" ? <TerminalView /> : null}` (component from Task 10). Until Task 10 lands, temporarily render `null` — but since tasks land in order, implement Task 10 before adding this branch, OR add the branch here and stub `TerminalView`. To keep each task green, ADD THE SEGMENTED OPTION AND VIEW BRANCH IN TASK 10, not here. In this task only add the dock + toggle + indicator.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/layout/TerminalDock.test.tsx && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add src/layout/TerminalDock.tsx src/layout/TerminalDock.test.tsx src/layout/Shell.tsx
git commit -m "feat(terminals): add bottom terminal dock, title-bar toggle and indicator"
```

---

### Task 10: `TerminalView` full-height host + view switch

**Files:**
- Create: `src/layout/TerminalView.tsx`
- Modify: `src/layout/Shell.tsx` (add `"terminals"` to `Segmented`; add `view === "terminals"` branch)
- Modify: `src/state/persistence.ts` — already includes `"terminals"` in `LAYOUT_VIEWS` from Task 6 (verify).
- Test: `src/layout/TerminalView.test.tsx`

**Interfaces:**
- Consumes: `useSessions` (active project + cwd, same derivation as `TerminalDock`), `TerminalWorkspace`.
- Produces: `export function TerminalView(): JSX.Element` — a full-height container (sidebar optional; keep it simple: full-width center) rendering `<TerminalWorkspace cwd={cwd} projectId={projectId} visible />`.

- [ ] **Step 1: Write the failing test**

Create `src/layout/TerminalView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalWorkspace.tsx", () => ({
  TerminalWorkspace: ({ visible }: { visible: boolean }) => (
    <div data-testid="workspace" data-visible={visible} />
  ),
}));

import { TerminalView } from "./TerminalView.tsx";

describe("TerminalView", () => {
  it("renders a visible workspace", () => {
    render(<TerminalView />);
    expect(screen.getByTestId("workspace").getAttribute("data-visible")).toBe(
      "true"
    );
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/layout/TerminalView.test.tsx`
Expected: FAIL — cannot find `./TerminalView.tsx`.

- [ ] **Step 3: Implement `TerminalView`**

Create `src/layout/TerminalView.tsx` mirroring the project/cwd derivation from `TerminalDock`, wrapping `TerminalWorkspace` in a `div` filling `centerStyle`-like space (full height, `tokens.color.chrome.content` background).

- [ ] **Step 4: Wire the view into `Shell.tsx`**

- Add to `Segmented` options: `{ label: "Terminals", value: "terminals" }`.
- Add branch in `Shell`: `{view === "terminals" ? <ErrorBoundary label="Terminals view crashed."><TerminalView /></ErrorBoundary> : null}`.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/layout/TerminalView.test.tsx && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add src/layout/TerminalView.tsx src/layout/TerminalView.test.tsx src/layout/Shell.tsx
git commit -m "feat(terminals): add full-height Terminals view and view switch"
```

---

### Task 11: Full green + real-app QA

**Files:** none (verification task)

- [ ] **Step 1: Full check**

Run: `pnpm check`
Expected: typecheck, lint, and all tests PASS.

- [ ] **Step 2: Browser QA (fake store)** — per the browser QA routine: `pnpm dev`, drive via Playwright + `window.__kriyon`. Verify:
  - Toggling the dock shows/hides it; the indicator reflects live pane count.
  - Open tab, add tab, rename (double-click), close tab.
  - Split a pane (both directions), resize the split, close a pane; closing the last pane closes the tab.
  - Switch to the Terminals view; same workspace/state shown as the dock (shared store).

- [ ] **Step 3: Real-app QA (Tauri)** — Verify a real dev server:
  - In a project terminal run `pnpm dev` (or `sleep 999`); confirm it runs with the user's real env (`echo $PATH`, `node -v`).
  - Reload the webview (⌘R) → the terminal reattaches and output continues (survives reload).
  - Quit the app → confirm the daemon/process is gone (die-on-quit): `pgrep -fl kriyon-ptyd` shows the terminal's daemon terminated.
  - Open 4 panes + the Claude terminal; confirm no WebGL context errors in the console.

- [ ] **Step 4: Commit any QA fixes**, then the feature is complete.

---

## Self-Review

**Spec coverage:**
- Two hosts, one core → Tasks 5 (workspace), 9 (dock), 10 (view). ✓
- Per-project scope → store keyed by projectId (Task 2); active project derivation (Tasks 9/10). ✓
- Reattach-on-reload / die-on-quit → daemon reuse (existing) + Task 8. ✓
- Backend unchanged → confirmed; no Rust tasks. ✓
- Split via react-resizable-panels, flat model → Tasks 1, 4. ✓
- WebGL gating → handled by per-pane `active` wiring (Tasks 3/4); no `Terminal.tsx` change needed (≤5 visible contexts). ✓
- Indicator across all projects → `livePaneCount` (Task 2) + title-bar badge (Task 9). ✓
- Persistence of structure → Task 7; layout dock fields → Task 6. ✓
- Terminology in CONTEXT.md → Task 1. ✓

**Placeholder scan:** No "TBD"/"handle edge cases" left; every code step has concrete code or an explicit "mirror file X" reference with the exact fields to fill.

**Type consistency:** `TerminalPane`/`TerminalTab`/`ProjectTerminals`/`TerminalsState` names and action signatures are identical across Tasks 2, 4, 5, 7, 8. `livePaneCount`, `hydrate`, `setLayout`, `setDirection`, `setActivePane` spellings match. `Terminal` props (`active`, `cwd`, `sessionId`) match `src/terminal/Terminal.tsx`. `useLayout` field names (`terminalDockOpen`, `terminalDockHeight`) match across Tasks 6, 9.

**Open verification items (flagged inline, not blocking):**
- Exact `tokens` keys (`radius.sm`, `surface.hover`, `textMuted`) — verify against `src/theme/tokens.ts`; fall back to nearest existing.
- `persistence.test.ts` mock shape for a key-aware `loadLayout` — match the file's existing mock.
- macOS `onCloseRequested` quit-vs-reload behavior — confirm in real-app QA (Task 11 Step 3).
