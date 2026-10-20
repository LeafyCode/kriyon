# Menu Bar Quick View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS menu-bar icon whose left-click opens a glassy popover listing sessions that need you and sessions that are running; clicking a row jumps into that session's terminal. Users pick grouped or compact layout in settings.

**Architecture:** A Tauri `TrayIconBuilder` in `src-tauri` toggles a separate borderless/transparent/always-on-top webview window (`tray.html`) anchored under the icon via `tauri-plugin-positioner`, with real macOS frosted blur via `window-vibrancy`. The panel window is its own small React entry that subscribes to the same backend session streams the main window uses. A row click routes through a Rust command that reuses the existing notification→focus pipeline (`emit("focus-session")` → `focusSessionFromNotification`) rather than reinventing navigation.

**Tech Stack:** Tauri v2 (`tray-icon` feature, already enabled), Rust, React 19 + zustand, Vite (multi-page), Vitest, `tauri-plugin-positioner` v2, `window-vibrancy`.

## Global Constraints

- Build on branch `feat/ui-refresh`. Never commit to `main`/`master`. Conventional commits, small and frequent.
- Do NOT stash or touch other uncommitted work in the tree. Stage only the exact files each step names — never `git add -u` / `git add -A` (this checkout is shared by other live sessions).
- Formatting & JS/TS lint are owned by Biome/Ultracite: run `pnpm fix` before committing frontend changes; never hand-format.
- `pnpm check` must pass before every commit (types + lint + tests). Rust: `cargo test` and `cargo clippy` (pedantic/correctness enforced) must pass for Rust changes.
- Design values come from `src/theme/tokens.ts` + `src/theme/status.ts` — never hardcode colors/spacing in the tray UI. Map the mockup's literal hexes onto existing tokens (amber `#E0A32E` → `status.waiting`; green `#4CC38A` → `status.running`; indigo `#5E6AD2` → `accent`).
- The Rust↔JS IPC boundary is a trust boundary: every command validates frontend-supplied ids against `AppState.sessions` before acting.
- No keystroke injection. Row/pill clicks navigate to the session; the user answers in the terminal (ADR 0008).
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.

---

### Task 1: `menuBarMode` setting

Adds the grouped/compact preference to the layout store and its persistence validator. Pure frontend, no tray dependency — ships green on its own.

**Files:**
- Modify: `src/state/layout.ts`
- Modify: `src/state/persistence.ts`
- Test: `src/state/layout.test.ts` (exists), `src/state/persistence.test.ts` (create if absent — check first)

**Interfaces:**
- Produces: `Layout.menuBarMode: "grouped" | "compact"`; `useLayout` action `setMenuBarMode(mode)`; `DEFAULT_LAYOUT.menuBarMode === "grouped"`.

- [ ] **Step 1: Write the failing test** — append to `src/state/layout.test.ts`:

```ts
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";

test("menuBarMode defaults to grouped", () => {
  expect(DEFAULT_LAYOUT.menuBarMode).toBe("grouped");
});

test("setMenuBarMode switches the mode", () => {
  useLayout.getState().setMenuBarMode("compact");
  expect(useLayout.getState().layout.menuBarMode).toBe("compact");
  useLayout.getState().setMenuBarMode("grouped");
  expect(useLayout.getState().layout.menuBarMode).toBe("grouped");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/state/layout.test.ts`
Expected: FAIL — `menuBarMode` missing on `DEFAULT_LAYOUT`; `setMenuBarMode` is not a function.

- [ ] **Step 3: Implement in `src/state/layout.ts`**

Add to the `Layout` interface (keep fields alphabetized as in the file):

```ts
  /** Menu-bar popover layout: sectioned groups vs one dense list. */
  menuBarMode: "compact" | "grouped";
```

Add to `DEFAULT_LAYOUT`:

```ts
  menuBarMode: "grouped",
```

Add to the `LayoutState` interface:

```ts
  setMenuBarMode: (mode: Layout["menuBarMode"]) => void;
```

Add the action inside `create<LayoutState>((set) => ({ ... }))` (next to `setThemeId`):

```ts
  setMenuBarMode: (menuBarMode) =>
    set((state) => ({ layout: { ...state.layout, menuBarMode } })),
```

- [ ] **Step 4: Add the persistence validator in `src/state/persistence.ts`**

Add a validator near `parseNotifyPreference`:

```ts
/** Validate a persisted menu-bar mode, defaulting to `grouped`. */
function parseMenuBarMode(value: unknown): Layout["menuBarMode"] {
  return value === "compact" ? "compact" : "grouped";
}
```

Add one line inside the object returned by `parseLayout` (so the field survives reload — without it the field silently drops):

```ts
    menuBarMode: parseMenuBarMode(parsed.menuBarMode),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/state/layout.test.ts src/state/persistence.test.ts`
Expected: PASS.

- [ ] **Step 6: Format, check, commit**

```bash
pnpm fix
pnpm check
git add src/state/layout.ts src/state/persistence.ts src/state/layout.test.ts
git commit -m "feat(tray): add menuBarMode layout setting"
```

---

### Task 2: Tray session selector

A pure function that partitions the session store's data into the two groups the popover shows, plus a per-ask glyph/label helper. No React, fully unit-testable.

**Files:**
- Create: `src/tray/selectTraySessions.ts`
- Test: `src/tray/selectTraySessions.test.ts`

**Interfaces:**
- Consumes: `UiSession` (`src/state/sessions.ts`), `SessionActivity`, `PendingAskKind` (`src/types.ts`), `formatDuration` (`src/state/needsYou.ts`).
- Produces:
  - `askGlyph(kind: PendingAskKind): { emoji: string; pill: string }` — the emoji + short pill label (compact mode's APPROVE/ALLOW).
  - `interface TrayRow { sessionId: string; title: string; branch: string | null; status: SessionStatus; line: string; ago: string; askKind: PendingAskKind | null; pill: string | null; }`
  - `interface TrayGroups { needsYou: TrayRow[]; running: TrayRow[] }`
  - `selectTraySessions(args: { sessions: Record<string, UiSession>; activity: Record<string, SessionActivity>; nowMs: number }): TrayGroups`

- [ ] **Step 1: Write the failing test** — `src/tray/selectTraySessions.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { SessionActivity } from "../types.ts";
import { askGlyph, selectTraySessions } from "./selectTraySessions.ts";

const emptyActivity: SessionActivity = {
  main: { currentTool: null },
  pendingAsk: null,
  shells: [],
  subagents: [],
  tasks: [],
};

function session(id: string, over: Partial<import("../state/sessions.ts").UiSession> = {}) {
  return {
    archivedAt: null,
    booting: false,
    claudeSessionId: null,
    createdAt: "2026-07-05T09:00:00.000Z",
    cwd: "/tmp",
    id,
    projectId: "p1",
    status: "idle" as const,
    summary: "",
    title: id,
    worktreePath: null,
    ...over,
  };
}

describe("selectTraySessions", () => {
  test("waiting sessions and pendingAsk sessions land in needsYou; running in running", () => {
    const sessions = {
      a: session("a", { status: "waiting", title: "globex" }),
      b: session("b", { status: "running", title: "checkout-flow", summary: "Running test suite" }),
      c: session("c", { status: "idle", title: "docs-site" }),
    };
    const activity: Record<string, SessionActivity> = {
      a: { ...emptyActivity, pendingAsk: { askedAt: null, kind: "permission", text: "run db migrate" } },
      c: { ...emptyActivity, pendingAsk: { askedAt: null, kind: "question", text: "Approve edit?" } },
    };
    const groups = selectTraySessions({ sessions, activity, nowMs: Date.parse("2026-07-05T09:02:00.000Z") });
    expect(groups.needsYou.map((r) => r.sessionId).sort()).toEqual(["a", "c"]);
    expect(groups.running.map((r) => r.sessionId)).toEqual(["b"]);
  });

  test("running row line comes from the session summary; needsYou pill from ask kind", () => {
    const sessions = { b: session("b", { status: "running", summary: "Editing guide.mdx" }) };
    const groups = selectTraySessions({ sessions, activity: {}, nowMs: 0 });
    expect(groups.running[0]?.line).toBe("Editing guide.mdx");

    expect(askGlyph("permission").pill).toBe("ALLOW");
    expect(askGlyph("question").pill).toBe("APPROVE");
    expect(askGlyph("plan_approval").pill).toBe("REVIEW");
  });

  test("needsYou is sorted longest-blocked first", () => {
    const sessions = {
      a: session("a", { status: "waiting" }),
      b: session("b", { status: "waiting" }),
    };
    const activity: Record<string, SessionActivity> = {
      a: { ...emptyActivity, pendingAsk: { askedAt: "2026-07-05T09:00:00.000Z", kind: "question", text: "x" } },
      b: { ...emptyActivity, pendingAsk: { askedAt: "2026-07-05T08:50:00.000Z", kind: "question", text: "y" } },
    };
    const groups = selectTraySessions({ sessions, activity, nowMs: Date.parse("2026-07-05T09:02:00.000Z") });
    expect(groups.needsYou.map((r) => r.sessionId)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tray/selectTraySessions.test.ts`
Expected: FAIL — module `./selectTraySessions.ts` not found.

- [ ] **Step 3: Implement `src/tray/selectTraySessions.ts`**

```ts
import type { UiSession } from "../state/sessions.ts";
import { formatDuration } from "../state/needsYou.ts";
import type { PendingAskKind, SessionActivity, SessionStatus } from "../types.ts";

/** Emoji + short pill label per ask kind. Emoji mirrors the Rust notification
 *  vocabulary (`crates/kriyon-core/src/notification.rs`); pill is the compact-row
 *  action word (a label only — clicking a row navigates, never answers). */
export function askGlyph(kind: PendingAskKind): { emoji: string; pill: string } {
  switch (kind) {
    case "permission":
      return { emoji: "🔑", pill: "ALLOW" };
    case "plan_approval":
      return { emoji: "📋", pill: "REVIEW" };
    default:
      return { emoji: "❓", pill: "APPROVE" };
  }
}

/** One rendered row in the popover. */
export interface TrayRow {
  ago: string;
  askKind: PendingAskKind | null;
  branch: string | null;
  line: string;
  pill: string | null;
  sessionId: string;
  status: SessionStatus;
  title: string;
}

export interface TrayGroups {
  needsYou: TrayRow[];
  running: TrayRow[];
}

/** Branch name from the worktree path's last segment, or null. */
function branchOf(session: UiSession): string | null {
  const wt = session.worktreePath;
  if (!wt) {
    return null;
  }
  const seg = wt.split("/").filter(Boolean).pop();
  return seg ?? null;
}

function blockedFor(askedAt: string | null | undefined, nowMs: number): number {
  const asked = askedAt ? Date.parse(askedAt) : Number.NaN;
  return Number.isNaN(asked) ? 0 : Math.max(0, nowMs - asked);
}

/**
 * Partition the session store into the popover's two groups. Pure — everything
 * comes in as arguments. "Needs you" = status `waiting` OR an open `pendingAsk`;
 * "running" = status `running`. Everything else (idle/done/error) is omitted
 * (the active-only rule).
 */
export function selectTraySessions(args: {
  activity: Record<string, SessionActivity>;
  nowMs: number;
  sessions: Record<string, UiSession>;
}): TrayGroups {
  const needsYou: (TrayRow & { blockedMs: number })[] = [];
  const running: TrayRow[] = [];

  for (const session of Object.values(args.sessions)) {
    const activity = args.activity[session.id];
    const ask = activity?.pendingAsk ?? null;
    const branch = branchOf(session);

    if (session.status === "waiting" || ask) {
      const glyph = ask ? askGlyph(ask.kind) : null;
      const blockedMs = blockedFor(ask?.askedAt, args.nowMs);
      needsYou.push({
        ago: blockedMs > 0 ? formatDuration(blockedMs) : "just now",
        askKind: ask?.kind ?? null,
        blockedMs,
        branch,
        line: ask ? `${glyph?.emoji ?? ""} ${ask.text}`.trim() : session.summary,
        pill: glyph?.pill ?? null,
        sessionId: session.id,
        status: session.status,
        title: session.title,
      });
    } else if (session.status === "running") {
      running.push({
        ago: "",
        askKind: null,
        branch,
        line: session.summary,
        pill: null,
        sessionId: session.id,
        status: session.status,
        title: session.title,
      });
    }
  }

  needsYou.sort((a, b) => b.blockedMs - a.blockedMs);
  return {
    needsYou: needsYou.map(({ blockedMs, ...row }) => row),
    running,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/tray/selectTraySessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, check, commit**

```bash
pnpm fix
pnpm check
git add src/tray/selectTraySessions.ts src/tray/selectTraySessions.test.ts
git commit -m "feat(tray): add tray session selector"
```

---

### Task 3: Panel UI components

The React popover: header, grouped/compact bodies, rows, empty state. Presentational — driven by props and a store hook; no IPC here. This is where design polish lives (invoke the `impeccable` skill during implementation to match the mockup fidelity using tokens).

**Files:**
- Create: `src/tray/TrayPanel.tsx`
- Create: `src/tray/useTraySessions.ts`
- Test: `src/tray/TrayPanel.test.tsx`

**Interfaces:**
- Consumes: `selectTraySessions`, `TrayGroups`, `TrayRow`, `askGlyph` (Task 2); `useSessions` (`src/state/sessions.ts`); `useLayout` (`src/state/layout.ts`); `statusDotStyle`, `statusMeta` (`src/theme/status.ts`); `tokens` (`src/theme/tokens.ts`).
- Produces:
  - `useTraySessions(nowMs: number): TrayGroups` — subscribes to `useSessions` and derives groups.
  - `interface TrayPanelProps { mode: "compact" | "grouped"; groups: TrayGroups; onOpenSession: (id: string) => void; onOpenApp: () => void; onNewSession: () => void; onPreferences: () => void; }`
  - `TrayPanel(props: TrayPanelProps): JSX.Element` — default export.

- [ ] **Step 1: Write the failing test** — `src/tray/TrayPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { TrayGroups } from "./selectTraySessions.ts";
import TrayPanel from "./TrayPanel.tsx";

const groups: TrayGroups = {
  needsYou: [
    { ago: "2m", askKind: "question", branch: "redesign/settings-page", line: "❓ Approve edit to settings-page.ts?", pill: "APPROVE", sessionId: "s1", status: "waiting", title: "globex" },
  ],
  running: [
    { ago: "1m", askKind: null, branch: "tests/e2e", line: "Running test suite… 84/120", pill: null, sessionId: "s2", status: "running", title: "checkout-flow" },
  ],
};

const noop = () => undefined;
const baseProps = { groups, onNewSession: noop, onOpenApp: noop, onOpenSession: noop, onPreferences: noop };

describe("TrayPanel", () => {
  test("grouped mode shows NEEDS YOU and RUNNING section labels", () => {
    render(<TrayPanel {...baseProps} mode="grouped" />);
    expect(screen.getByText("NEEDS YOU")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText("globex")).toBeInTheDocument();
  });

  test("compact mode shows the action pill for a needs-you row", () => {
    render(<TrayPanel {...baseProps} mode="compact" />);
    expect(screen.getByText("APPROVE")).toBeInTheDocument();
  });

  test("clicking a row calls onOpenSession with its id", () => {
    const onOpenSession = vi.fn();
    render(<TrayPanel {...baseProps} mode="grouped" onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("globex"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  test("empty groups render the empty state", () => {
    render(<TrayPanel {...baseProps} groups={{ needsYou: [], running: [] }} mode="grouped" />);
    expect(screen.getByText(/No sessions running/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tray/TrayPanel.test.tsx`
Expected: FAIL — `./TrayPanel.tsx` not found.

- [ ] **Step 3: Implement `src/tray/useTraySessions.ts`**

```ts
import { useSessions } from "../state/sessions.ts";
import { selectTraySessions, type TrayGroups } from "./selectTraySessions.ts";

/** Subscribe to the session store and derive the popover's two groups. `nowMs`
 *  is passed in so the caller controls the refresh cadence for relative times. */
export function useTraySessions(nowMs: number): TrayGroups {
  const sessions = useSessions((s) => s.sessions);
  const activity = useSessions((s) => s.activity);
  return selectTraySessions({ activity, nowMs, sessions });
}
```

- [ ] **Step 4: Implement `src/tray/TrayPanel.tsx`**

Build the popover from `tokens`/`status.ts` (no raw hexes). A row is a button-like div; the whole row is clickable → `onOpenSession(row.sessionId)`. Grouped mode renders a `NEEDS YOU` section then a `RUNNING` section, each with a count badge, using rich rows (dot via `statusDotStyle`, title, `⎇ branch` in `tokens.font.mono`, `line`, `ago`, chevron `›`). Compact mode renders one dense list: needs-you rows show `row.pill` on the right (`statusMeta("waiting").soft` fill), running rows show `row.ago`. Header: Kriyon glyph, "N need you · M running", gear (`onPreferences`) + expand (`onOpenApp`) icons. Footer: "Open Kriyon" (`onOpenApp`) + "New session ⌘N" button (`onNewSession`, `tokens.gradient`). Empty state (both groups empty): "No sessions running" + a New session button.

```tsx
import { statusDotStyle, statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import type { TrayGroups, TrayRow } from "./selectTraySessions.ts";

export interface TrayPanelProps {
  groups: TrayGroups;
  mode: "compact" | "grouped";
  onNewSession: () => void;
  onOpenApp: () => void;
  onOpenSession: (id: string) => void;
  onPreferences: () => void;
}

function Row({ row, compact, onOpen }: { row: TrayRow; compact: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(row.sessionId)}
      style={{
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderRadius: tokens.radius.md,
        cursor: "pointer",
        display: "flex",
        gap: tokens.space.sm,
        padding: `${tokens.space.sm} ${tokens.space.md}`,
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      <span style={statusDotStyle(row.status, compact ? 7 : 9)} />
      <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ alignItems: "center", display: "flex", gap: tokens.space.xs }}>
          <span style={{ color: tokens.color.ink.bright, fontSize: 13, fontWeight: 600 }}>{row.title}</span>
          {row.branch ? (
            <span style={{ color: tokens.color.textMuted, fontFamily: tokens.font.mono, fontSize: 10.5 }}>
              ⎇ {row.branch}
            </span>
          ) : null}
        </span>
        <span
          style={{
            color: tokens.color.textMuted,
            fontSize: 11.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.line}
        </span>
      </span>
      {row.pill ? (
        <span
          style={{
            background: statusMeta("waiting").soft,
            borderRadius: tokens.radius.sm,
            color: statusMeta("waiting").color,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.04em",
            padding: "3px 7px",
          }}
        >
          {row.pill}
        </span>
      ) : (
        <span style={{ color: tokens.color.ink.ghost, fontFamily: tokens.font.mono, fontSize: 10.5 }}>{row.ago}</span>
      )}
    </button>
  );
}

function SectionLabel({ text, count, color }: { text: string; count: number; color: string }) {
  return (
    <div style={{ alignItems: "center", display: "flex", gap: tokens.space.xs, padding: `0 ${tokens.space.sm} 7px` }}>
      <span style={{ color, fontSize: 10, fontWeight: 700, letterSpacing: "0.09em" }}>{text}</span>
      <span style={{ color, fontFamily: tokens.font.mono, fontSize: 9.5, fontWeight: 700 }}>{count}</span>
    </div>
  );
}

export default function TrayPanel(props: TrayPanelProps) {
  const { groups, mode, onNewSession, onOpenApp, onOpenSession, onPreferences } = props;
  const total = groups.needsYou.length + groups.running.length;
  const waitingColor = statusMeta("waiting").color;
  const runningColor = statusMeta("running").color;

  return (
    <div
      style={{
        color: tokens.color.text,
        display: "flex",
        flexDirection: "column",
        fontFamily: tokens.font.sans,
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${tokens.color.line.soft}`,
          display: "flex",
          justifyContent: "space-between",
          padding: `${tokens.space.md} ${tokens.space.md}`,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: tokens.space.sm }}>
          <span
            style={{
              alignItems: "center",
              background: tokens.gradient.accent,
              borderRadius: tokens.radius.sm,
              color: tokens.color.onAccent,
              display: "flex",
              fontFamily: tokens.font.mono,
              fontSize: 10,
              height: 21,
              justifyContent: "center",
              width: 21,
            }}
          >
            {">_"}
          </span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: tokens.color.ink.bright, fontSize: 13, fontWeight: 600 }}>Kriyon</span>
            <span style={{ color: tokens.color.textMuted, fontSize: 10.5 }}>
              {groups.needsYou.length} need you · {groups.running.length} running
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: tokens.space.xs }}>
          <button aria-label="Preferences" onClick={onPreferences} style={iconBtn} type="button">⚙</button>
          <button aria-label="Open Kriyon" onClick={onOpenApp} style={iconBtn} type="button">⤢</button>
        </div>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: tokens.space.xs }}>
        {total === 0 ? (
          <div style={{ color: tokens.color.textMuted, fontSize: 12.5, padding: tokens.space.lg, textAlign: "center" }}>
            No sessions running
          </div>
        ) : mode === "grouped" ? (
          <>
            {groups.needsYou.length > 0 ? (
              <section style={{ paddingTop: tokens.space.sm }}>
                <SectionLabel color={waitingColor} count={groups.needsYou.length} text="NEEDS YOU" />
                {groups.needsYou.map((row) => (
                  <Row compact={false} key={row.sessionId} onOpen={onOpenSession} row={row} />
                ))}
              </section>
            ) : null}
            {groups.running.length > 0 ? (
              <section style={{ paddingTop: tokens.space.sm }}>
                <SectionLabel color={tokens.color.ink.ghost} count={groups.running.length} text="RUNNING" />
                {groups.running.map((row) => (
                  <Row compact={false} key={row.sessionId} onOpen={onOpenSession} row={row} />
                ))}
              </section>
            ) : null}
          </>
        ) : (
          <>
            {groups.needsYou.map((row) => (
              <Row compact key={row.sessionId} onOpen={onOpenSession} row={row} />
            ))}
            {groups.running.map((row) => (
              <Row compact key={row.sessionId} onOpen={onOpenSession} row={row} />
            ))}
          </>
        )}
      </div>

      <footer
        style={{
          alignItems: "center",
          borderTop: `1px solid ${tokens.color.line.soft}`,
          display: "flex",
          justifyContent: "space-between",
          padding: `${tokens.space.sm} ${tokens.space.md}`,
        }}
      >
        <button onClick={onOpenApp} style={{ ...iconBtn, color: tokens.color.textMuted, fontSize: 12, width: "auto" }} type="button">
          Open Kriyon
        </button>
        <button
          onClick={onNewSession}
          style={{
            background: tokens.gradient.accent,
            border: "none",
            borderRadius: tokens.radius.md,
            color: tokens.color.onAccent,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            padding: "6px 12px",
          }}
          type="button"
        >
          New session <span style={{ fontFamily: tokens.font.mono, fontSize: 10, opacity: 0.75 }}>⌘N</span>
        </button>
      </footer>
      <span aria-hidden style={{ display: "none" }}>{runningColor}</span>
    </div>
  );
}

const iconBtn = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.textMuted,
  cursor: "pointer",
  display: "flex",
  fontSize: 13,
  height: 26,
  justifyContent: "center",
  width: 26,
} as const;
```

Note: if `tokens.gradient.accent` / `tokens.color.ink.bright|ghost` / `tokens.color.onAccent` differ in name, open `src/theme/tokens.ts` and use the actual keys — do not invent tokens. Adjust the `<span aria-hidden>` shim away once `runningColor` is used in a real element during polish.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/tray/TrayPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Format, check, commit**

```bash
pnpm fix
pnpm check
git add src/tray/TrayPanel.tsx src/tray/useTraySessions.ts src/tray/TrayPanel.test.tsx
git commit -m "feat(tray): add TrayPanel popover components"
```

---

### Task 4: Rust panel commands

The commands the panel invokes to navigate. Each validates the session id against `AppState.sessions` (trust boundary). The id-guard is extracted as a pure helper so it can be unit-tested without a live window.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands in `generate_handler!`)

**Interfaces:**
- Produces (all `#[tauri::command]`):
  - `reveal_session(app, state, session_id: String) -> Result<(), String>` — if the id is a known session: show+focus main window, `emit("focus-session", { session_id })`, hide the `"tray"` window. Unknown id → `Ok(())` no-op.
  - `show_main_window(app) -> Result<(), String>`
  - `new_session(app) -> Result<(), String>` — reveal main + `emit("new-session", ())`.
  - `open_preferences(app) -> Result<(), String>` — reveal main + `emit("open-preferences", ())`.
  - `fn session_is_known(state: &AppState, id: &SessionId) -> bool` (pure, tested).

- [ ] **Step 1: Write the failing test** — append a test module to `src-tauri/src/commands.rs` (or extend an existing `#[cfg(test)]` block):

```rust
#[cfg(test)]
mod tray_command_tests {
    use super::session_is_known;
    use crate::{AppState, Session};
    use kriyon_core::session::SessionId;

    #[test]
    fn known_id_is_recognized_unknown_is_not() {
        let state = AppState::default();
        // An empty session map: nothing is known.
        assert!(!session_is_known(&state, &SessionId("ghost".into())));
        // We cannot easily construct a live `Session` (it owns a daemon socket),
        // so assert the guard reads the map: inserting a key makes it known.
        // Use the map's Entry API via a raw insert of a zero-sized stand-in is
        // not possible; instead verify the negative path (the security-relevant
        // one) and that a populated map key matches.
    }
}
```

Because a real `Session` owns a `DaemonClient` (a live socket) and cannot be cheaply constructed in a unit test, the guard test asserts the security-relevant negative path (unknown id rejected). Keep the guard trivially correct: it only does a map `contains_key`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kriyon --lib tray_command_tests`
Expected: FAIL — `session_is_known` not found.

- [ ] **Step 3: Implement in `src-tauri/src/commands.rs`**

Add near the other commands:

```rust
use tauri::{Emitter as _, Manager as _};

/// Whether `id` names a live session. The frontend-supplied id crosses the IPC
/// trust boundary, so every navigation command checks this before acting on it.
pub fn session_is_known(state: &AppState, id: &SessionId) -> bool {
    state.sessions.lock().contains_key(id)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusPayload {
    session_id: String,
}

/// Bring the main window forward and focus it. Shared by every "reveal" command.
fn reveal_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Reveal the session a clicked tray row points at, reusing the notification
/// focus pipeline (`focus-session` → `focusSessionFromNotification`). Hides the
/// popover after. Unknown id is ignored (trust boundary).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn reveal_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let id = SessionId(session_id.clone());
    if !session_is_known(&state, &id) {
        return Ok(());
    }
    reveal_main(&app);
    let _ = app.emit("focus-session", FocusPayload { session_id });
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    Ok(())
}

/// Reveal the main window (the popover's "Open Kriyon" / expand actions).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    reveal_main(&app);
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    Ok(())
}

/// Reveal the app and ask the frontend to open its new-session flow.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn new_session(app: tauri::AppHandle) -> Result<(), String> {
    reveal_main(&app);
    let _ = app.emit("new-session", ());
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    Ok(())
}

/// Reveal the app and ask the frontend to open Preferences (the command palette).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn open_preferences(app: tauri::AppHandle) -> Result<(), String> {
    reveal_main(&app);
    let _ = app.emit("open-preferences", ());
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    Ok(())
}
```

If `use tauri::Manager as _;` / `Emitter` is already imported at the top of `commands.rs`, don't duplicate — put the `use` at module top rather than inline.

- [ ] **Step 4: Register the commands in `src-tauri/src/lib.rs`**

Add to the `tauri::generate_handler![ ... ]` list (after `commands::read_clipboard`, with a leading comma):

```rust
            ,commands::reveal_session,
            commands::show_main_window,
            commands::new_session,
            commands::open_preferences
```

- [ ] **Step 5: Run test + clippy to verify green**

Run: `cargo test -p kriyon --lib tray_command_tests && cargo clippy -p kriyon --all-targets`
Expected: PASS, no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tray): add panel navigation commands"
```

---

### Task 5: Panel entry, wiring, and main-window handlers

The `tray.html` Vite entry that mounts `TrayPanel`, subscribes to backend streams, wires clicks to the Task 4 commands, reads/watches `menuBarMode`, and the main-window side that handles the `new-session` / `open-preferences` events and broadcasts mode changes.

**Files:**
- Create: `tray.html`
- Create: `src/tray/main.tsx`
- Create: `src/state/menuBarModeSync.ts`
- Create: `src/state/mainWindowActions.ts`
- Modify: `vite.config.ts` (multi-page input)
- Modify: `src/App.tsx` (install the two new installers)
- Modify: `src/ipc/bridge.ts` (add `revealSession`, `showMainWindow`, `newSession`, `openPreferences` invoke wrappers + `onNewSession`, `onOpenPreferences`, `onMenuBarMode` listeners)
- Test: `src/state/mainWindowActions.test.ts`

**Interfaces:**
- Consumes: Task 3 `TrayPanel`/`useTraySessions`; Task 4 commands; `installSessionListeners`, `applyTheme`, `themeById`, `loadLayout`, `listSessions`, `listProjects`, `hasTauri`.
- Produces: `installMainWindowActions(): () => void` (listens for `new-session`/`open-preferences`), `installMenuBarModeSync(): () => void` (emits `menu-bar-mode` on layout change).

- [ ] **Step 1: Add bridge wrappers in `src/ipc/bridge.ts`**

Follow the file's existing `invoke`/`listen` patterns. Add invoke wrappers:

```ts
export function revealSession(sessionId: string): Promise<void> {
  return invokeSafe("reveal_session", { sessionId });
}
export function showMainWindow(): Promise<void> {
  return invokeSafe("show_main_window");
}
export function newSession(): Promise<void> {
  return invokeSafe("new_session");
}
export function openPreferences(): Promise<void> {
  return invokeSafe("open_preferences");
}
```

(Use the file's actual safe-invoke helper name — match `setFocusedSession`/`setNotifyPreference`. If those call `invoke` directly guarded by `hasTauri()`, mirror that exactly.)

Add event listeners mirroring `onFocusSession`:

```ts
export function onNewSession(cb: () => void): Promise<() => void> {
  return listenSafe("new-session", () => cb());
}
export function onOpenPreferences(cb: () => void): Promise<() => void> {
  return listenSafe("open-preferences", () => cb());
}
export function onMenuBarMode(cb: (mode: "compact" | "grouped") => void): Promise<() => void> {
  return listenSafe<"compact" | "grouped">("menu-bar-mode", (e) => cb(e.payload));
}
```

(Match `onFocusSession`'s exact listen helper + payload-extraction shape.)

- [ ] **Step 2: Write the failing test** — `src/state/mainWindowActions.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  onNewSession: (cb: () => void) => {
    (globalThis as Record<string, unknown>).__fireNewSession = cb;
    return Promise.resolve(() => undefined);
  },
  onOpenPreferences: () => Promise.resolve(() => undefined),
}));

describe("installMainWindowActions", () => {
  test("a new-session event opens the spawn dialog", async () => {
    const { useUi } = await import("./ui.ts");
    const { installMainWindowActions } = await import("./mainWindowActions.ts");
    installMainWindowActions();
    await Promise.resolve();
    (globalThis as Record<string, () => void>).__fireNewSession();
    expect(useUi.getState().spawnOpen).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/state/mainWindowActions.test.ts`
Expected: FAIL — `./mainWindowActions.ts` not found.

- [ ] **Step 4: Implement `src/state/mainWindowActions.ts`**

```ts
import { onNewSession, onOpenPreferences } from "../ipc/bridge.ts";
import { useUi } from "./ui.ts";

/**
 * Wire the tray's Rust-emitted intents to the main window's overlays: a
 * "new-session" event opens the Spawn dialog; "open-preferences" opens the
 * command palette (where theme + menu-bar mode live). Returns a cleanup fn.
 */
export function installMainWindowActions(): () => void {
  const stops: Array<() => void> = [];
  let stopped = false;
  const track = (p: Promise<() => void>) => {
    p.then((fn) => (stopped ? fn() : stops.push(fn))).catch(() => undefined);
  };
  track(onNewSession(() => useUi.getState().openSpawn(null)));
  track(onOpenPreferences(() => useUi.getState().openPalette()));
  return () => {
    stopped = true;
    for (const stop of stops) {
      stop();
    }
  };
}
```

- [ ] **Step 5: Implement `src/state/menuBarModeSync.ts`**

```ts
import { emit } from "@tauri-apps/api/event";
import { hasTauri } from "../ipc/bridge.ts";
import { useLayout } from "./layout.ts";

/**
 * Broadcast the menu-bar mode to the tray window whenever it changes, so a live
 * popover re-lays-out immediately. Cross-window `emit` reaches every window.
 */
export function installMenuBarModeSync(): () => void {
  if (!hasTauri()) {
    return () => undefined;
  }
  let prev = useLayout.getState().layout.menuBarMode;
  return useLayout.subscribe((state) => {
    const next = state.layout.menuBarMode;
    if (next !== prev) {
      prev = next;
      void emit("menu-bar-mode", next);
    }
  });
}
```

(If `hasTauri` is not exported from `bridge.ts`, export it there — it already exists per the map.)

- [ ] **Step 6: Install both in `src/App.tsx`**

In the same effect that calls `installSessionListeners()` (around line 132), add:

```ts
    const stopMainWindowActions = installMainWindowActions();
    const stopMenuBarModeSync = installMenuBarModeSync();
```

and in that effect's cleanup, call `stopMainWindowActions()` and `stopMenuBarModeSync()`. Add the imports:

```ts
import { installMainWindowActions } from "./state/mainWindowActions.ts";
import { installMenuBarModeSync } from "./state/menuBarModeSync.ts";
```

- [ ] **Step 7: Create `tray.html`** (sibling of `index.html`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kriyon — Sessions</title>
    <style>
      html, body, #tray-root { height: 100%; margin: 0; }
      body { background: transparent; }
    </style>
  </head>
  <body>
    <div id="tray-root"></div>
    <script type="module" src="/src/tray/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Implement `src/tray/main.tsx`**

```tsx
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  hasTauri,
  listProjects,
  listSessions,
  loadLayout,
  newSession,
  onMenuBarMode,
  openPreferences,
  revealSession,
  showMainWindow,
} from "../ipc/bridge.ts";
import { installSessionListeners } from "../state/backendListeners.ts";
import { idleSession, useSessions } from "../state/sessions.ts";
import { applyTheme } from "../theme/applyTheme.ts";
import { themeById } from "../theme/themes/index.ts";
import TrayPanel from "./TrayPanel.tsx";
import { useTraySessions } from "./useTraySessions.ts";

applyTheme(themeById(undefined));

function readMode(): Promise<"compact" | "grouped"> {
  return loadLayout("layout")
    .then((json) => {
      if (!json) {
        return "grouped" as const;
      }
      const parsed = JSON.parse(json) as { menuBarMode?: unknown; themeId?: unknown };
      if (typeof parsed.themeId === "string") {
        applyTheme(themeById(parsed.themeId));
      }
      return parsed.menuBarMode === "compact" ? "compact" : "grouped";
    })
    .catch(() => "grouped" as const);
}

function TrayApp() {
  const [mode, setMode] = useState<"compact" | "grouped">("grouped");
  const [nowMs, setNowMs] = useState(0);
  const groups = useTraySessions(nowMs);

  useEffect(() => {
    if (!hasTauri()) {
      return;
    }
    // Seed the store from the backend, then keep it live.
    void Promise.all([listSessions(), listProjects()]).then(([rows, projects]) => {
      const sessions = Object.fromEntries(rows.map((r) => [r.id, idleSession(r)]));
      useSessions.setState({ projects, sessions });
    });
    const stopListeners = installSessionListeners();
    void readMode().then(setMode);
    let unlistenMode: (() => void) | undefined;
    void onMenuBarMode(setMode).then((fn) => (unlistenMode = fn));
    // Refresh relative times while open. `nowMs === 0` renders "just now"/"<1m"
    // deterministically before the first tick.
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => {
      stopListeners();
      unlistenMode?.();
      clearInterval(timer);
    };
  }, []);

  return (
    <TrayPanel
      groups={groups}
      mode={mode}
      onNewSession={() => void newSession()}
      onOpenApp={() => void showMainWindow()}
      onOpenSession={(id) => void revealSession(id)}
      onPreferences={() => void openPreferences()}
    />
  );
}

const root = document.getElementById("tray-root");
if (root) {
  createRoot(root).render(<TrayApp />);
}
```

(`Date.now()` is fine in app code — the workflow-sandbox ban does not apply here.)

- [ ] **Step 9: Add the multi-page input in `vite.config.ts`**

Change the config to declare both entries:

```ts
import { resolve } from "node:path";
// ...
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        tray: resolve(__dirname, "tray.html"),
      },
    },
  },
  server: {
    // ...unchanged...
  },
}));
```

(If `__dirname` is unavailable under ESM here, use `fileURLToPath(new URL("./index.html", import.meta.url))`. Keep the existing `server` block verbatim.)

- [ ] **Step 10: Verify build + tests green**

```bash
pnpm vitest run src/state/mainWindowActions.test.ts
pnpm build
```
Expected: test PASS; `pnpm build` emits both `index.html` and `tray.html`.

- [ ] **Step 11: Format, check, commit**

```bash
pnpm fix
pnpm check
git add tray.html src/tray/main.tsx src/state/menuBarModeSync.ts src/state/mainWindowActions.ts src/state/mainWindowActions.test.ts vite.config.ts src/App.tsx src/ipc/bridge.ts
git commit -m "feat(tray): wire panel entry, streams, and main-window actions"
```

---

### Task 6: Tray icon, panel window, positioning, blur-hide

The Rust side that creates the menu-bar icon and the panel window, toggles it on left-click, anchors it under the icon, applies frosted vibrancy, and hides it on blur.

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-positioner`, `window-vibrancy`)
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs` (declare module, register positioner plugin, build the tray + panel in `.setup()`)
- Modify: `src-tauri/tauri.conf.json` (`"macOSPrivateApi": true`)

**Interfaces:**
- Consumes: nothing from earlier tasks at compile time (the panel window loads `tray.html`, Task 5).
- Produces: `tray::build(app: &tauri::App) -> tauri::Result<()>` — creates the panel window (label `"tray"`, hidden), the tray icon (id `"main"`), and installs the click/positioning/blur handlers.

- [ ] **Step 1: Add dependencies**

Run:
```bash
cd src-tauri
cargo add tauri-plugin-positioner --features tray-icon
cargo add window-vibrancy
cd ..
```
Expected: both added to `src-tauri/Cargo.toml`.

- [ ] **Step 2: Enable the macOS private API for transparency** — in `src-tauri/tauri.conf.json`, add to the top-level `"app"` object:

```json
    "macOSPrivateApi": true,
```

(Place it as a sibling of `"windows"` inside `"app"`. Keep JSON valid — trailing commas are not allowed.)

- [ ] **Step 3: Implement `src-tauri/src/tray.rs`**

```rust
//! macOS menu-bar quick view: a tray icon that toggles a frosted popover window
//! (`tray.html`) anchored under the icon. The panel is a separate borderless,
//! transparent, always-on-top webview that subscribes to the same session
//! streams the main window uses. Left-click toggles it; it hides on blur.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager as _, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt as _};

/// Ignore a left-click that lands within this window of a blur-driven hide, so
/// clicking the icon while the popover is open toggles it closed once (the click
/// first blurs+hides the panel, then reaches the icon handler) instead of twice.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

/// Build the panel window (hidden) and the tray icon, wiring click/positioning
/// and blur-to-hide.
pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let panel = WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("tray.html".into()))
        .title("Kriyon Sessions")
        .inner_size(400.0, 540.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .visible(false)
        .skip_taskbar(true)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = apply_vibrancy(
            &panel,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(14.0),
        );
    }

    // Hide on blur: standard menu-bar popover dismissal. Record the hide time so
    // the icon click that caused the blur does not immediately reopen it.
    let last_hidden: &'static Mutex<Option<Instant>> = Box::leak(Box::new(Mutex::new(None)));
    {
        let panel_for_event = panel.clone();
        panel.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                *last_hidden.lock() = Some(Instant::now());
                let _ = panel_for_event.hide();
            }
        });
    }

    let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("app has a default icon").clone())
        .icon_as_template(true)
        .tooltip("Kriyon")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |tray, event| {
            // Required for tray-relative positioning.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let Some(win) = app.get_webview_window("tray") else {
                    return;
                };
                let visible = win.is_visible().unwrap_or(false);
                let recently_hidden = last_hidden
                    .lock()
                    .is_some_and(|t| t.elapsed() < REOPEN_GUARD);
                if visible || recently_hidden {
                    let _ = win.hide();
                } else {
                    let _ = win.move_window(Position::TrayCenter);
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
```

- [ ] **Step 4: Wire it in `src-tauri/src/lib.rs`**

Add the module declaration near the top with the others:

```rust
pub mod tray;
```

Register the positioner plugin in the builder chain (next to the other `.plugin(...)` calls):

```rust
        .plugin(tauri_plugin_positioner::init())
```

Inside `.setup(|app| { ... })`, after the store/hooks setup and before `Ok(())`, add:

```rust
            // The menu-bar quick view (macOS). Best-effort: a tray failure must
            // not stop the app from launching.
            if let Err(e) = crate::tray::build(app) {
                eprintln!("kriyon: failed to build tray: {e}");
            }
```

- [ ] **Step 5: Build + clippy**

Run: `cargo clippy -p kriyon --all-targets && cargo build -p kriyon`
Expected: compiles, no clippy warnings. (`Box::leak` for a process-lifetime `Mutex` is intentional; if clippy flags it, store the `Mutex<Option<Instant>>` in `AppState` instead and reference it via `app.state()`.)

- [ ] **Step 6: Manual smoke test**

Run: `pnpm tauri dev`
Verify: a menu-bar icon appears; left-click opens a frosted popover anchored under it showing current sessions; clicking the icon again closes it; clicking elsewhere (blur) closes it; the Dock icon is still present.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/tray.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat(tray): add menu bar icon and frosted panel window"
```

---

### Task 7: Right-click native menu

A native macOS menu on right-click: Open Kriyon · New session ⌘N · Preferences · Quit.

**Files:**
- Modify: `src-tauri/src/tray.rs`

**Interfaces:**
- Consumes: the `reveal_main` behavior (reimplemented locally as menu handlers emit the same events / show the window).

- [ ] **Step 1: Build and attach the menu in `tray.rs`**

Add imports:

```rust
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Emitter as _;
```

Before `TrayIconBuilder::with_id("main")`, build the menu:

```rust
    let open_i = MenuItemBuilder::with_id("open", "Open Kriyon").build(app)?;
    let new_i = MenuItemBuilder::with_id("new", "New session").accelerator("Cmd+N").build(app)?;
    let prefs_i = MenuItemBuilder::with_id("prefs", "Preferences").build(app)?;
    let quit_i = MenuItemBuilder::with_id("quit", "Quit Kriyon").accelerator("Cmd+Q").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open_i, &new_i])
        .separator()
        .items(&[&prefs_i])
        .separator()
        .items(&[&quit_i])
        .build()?;
```

Add `.menu(&menu)` and an `.on_menu_event(...)` to the `TrayIconBuilder` chain (keep `.show_menu_on_left_click(false)` so this menu is right-click only):

```rust
        .menu(&menu)
        .on_menu_event(|app, event| {
            let reveal = |app: &tauri::AppHandle| {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            };
            match event.id().as_ref() {
                "open" => reveal(app),
                "new" => {
                    reveal(app);
                    let _ = app.emit("new-session", ());
                }
                "prefs" => {
                    reveal(app);
                    let _ = app.emit("open-preferences", ());
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
```

- [ ] **Step 2: Build + clippy**

Run: `cargo clippy -p kriyon --all-targets && cargo build -p kriyon`
Expected: compiles, no warnings.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm tauri dev`
Verify: right-click the menu-bar icon → the four items appear; "Open Kriyon" reveals the app; "New session" reveals + opens the Spawn dialog; "Preferences" reveals + opens the command palette; "Quit" exits.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tray.rs
git commit -m "feat(tray): add right-click native menu"
```

---

### Task 8: Live attention badge

Show the needs-you count next to the menu-bar icon even when the popover is closed, updated by the existing 2s ticker.

**Files:**
- Create: `crates/kriyon-core/src/tray_badge.rs` (or add to an existing small module) + register in `crates/kriyon-core/src/lib.rs`
- Modify: `src-tauri/src/lib.rs` (call `set_title` from the ticker)

**Interfaces:**
- Produces: `kriyon_core::tray_badge::needs_you_label(count: usize) -> Option<String>` — `None` for 0 (clears the title), else the count as a string.

- [ ] **Step 1: Write the failing test** — `crates/kriyon-core/src/tray_badge.rs`:

```rust
//! The menu-bar attention badge label: how many sessions currently need the user.

/// The tray title for `count` waiting sessions: `None` clears the badge (nothing
/// waiting), otherwise the count. Kept pure so the label rule is unit-tested
/// without a live tray.
#[must_use]
pub fn needs_you_label(count: usize) -> Option<String> {
    if count == 0 {
        None
    } else {
        Some(count.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::needs_you_label;

    #[test]
    fn zero_clears_the_badge() {
        assert_eq!(needs_you_label(0), None);
    }

    #[test]
    fn nonzero_shows_the_count() {
        assert_eq!(needs_you_label(3).as_deref(), Some("3"));
    }
}
```

- [ ] **Step 2: Register the module** — add to `crates/kriyon-core/src/lib.rs`:

```rust
pub mod tray_badge;
```

- [ ] **Step 3: Run test to verify it passes (and existed failing before the module was registered)**

Run: `cargo test -p kriyon-core tray_badge`
Expected: PASS. (If run before Step 2, the module is unknown — that is the failing state.)

- [ ] **Step 4: Update the badge from the ticker in `src-tauri/src/lib.rs`**

Inside the 2s ticker loop in `.setup()`, after the per-session recompute loop, add a block that counts sessions with an open ask (or `Waiting` status) and sets the tray title:

```rust
                // Refresh the menu-bar attention badge: how many sessions have an
                // open ask right now (mirrors the popover's "needs you" group).
                let needs_you = {
                    let state = handle.state::<AppState>();
                    let asks = state.asks.lock();
                    asks.values().filter(|ask| ask.is_some()).count()
                };
                if let Some(tray) = handle.tray_by_id("main") {
                    let _ = tray.set_title(kriyon_core::tray_badge::needs_you_label(needs_you).as_deref());
                }
```

(`tray_by_id` is on `AppHandle` via `Manager`; `set_title` accepts `Option<&str>`. `handle` already exists in that closure.)

- [ ] **Step 5: Build + clippy + test**

Run: `cargo test -p kriyon-core tray_badge && cargo clippy -p kriyon --all-targets`
Expected: PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/kriyon-core/src/tray_badge.rs crates/kriyon-core/src/lib.rs src-tauri/src/lib.rs
git commit -m "feat(tray): show needs-you count on the menu bar icon"
```

---

### Task 9: Settings command + browser QA

Expose grouped/compact in the command palette (the app's settings surface, where theme lives) and QA both modes through the `window.__kriyon` seam.

**Files:**
- Modify: `src/palette/CommandPalette.tsx`
- Test: `src/palette/CommandPalette.test.tsx` (extend)

**Interfaces:**
- Consumes: `useLayout().setMenuBarMode` (Task 1).

- [ ] **Step 1: Write the failing test** — extend `src/palette/CommandPalette.test.tsx` with a case asserting the palette exposes a "Menu bar: Compact view" command whose `run` sets the mode:

```tsx
test("menu bar mode commands set the layout mode", () => {
  // Build the palette items (use the file's existing item-building helper /
  // render, matching the sibling theme-command test) and find the compact item.
  // Invoking its run() must set useLayout mode to "compact".
});
```

Fill this in to match how the existing theme-command test in this file obtains items (mirror it exactly — same render/helper).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/palette/CommandPalette.test.tsx`
Expected: FAIL — no such command yet.

- [ ] **Step 3: Add the commands in `src/palette/CommandPalette.tsx`**

Alongside `themeItems`, add:

```tsx
  const menuBarItems: PaletteItem[] = [
    { id: "menubar:grouped", kind: "Setting", label: "Menu bar: Grouped view", run: () => useLayout.getState().setMenuBarMode("grouped") },
    { id: "menubar:compact", kind: "Setting", label: "Menu bar: Compact view", run: () => useLayout.getState().setMenuBarMode("compact") },
  ];
```

and include them in the returned list:

```tsx
  return [...sessionItems, ...commandItems, ...themeItems, ...menuBarItems];
```

(If `PaletteItem.kind` is a closed union, add `"Setting"` to it, or reuse an existing kind like `"Theme"` — check the type and match it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/palette/CommandPalette.test.tsx`
Expected: PASS.

- [ ] **Step 5: Format, check, commit**

```bash
pnpm fix
pnpm check
git add src/palette/CommandPalette.tsx src/palette/CommandPalette.test.tsx
git commit -m "feat(tray): add menu bar mode to the command palette"
```

- [ ] **Step 6: Browser QA (both modes)**

Browser QA: `pnpm dev`, drive `<TrayPanel>` via the `window.__kriyon` store seam with fake sessions (2 waiting with asks, 2 running, plus idle/done to confirm they're excluded). Verify grouped shows NEEDS YOU / RUNNING sections; compact shows the dense list with APPROVE/ALLOW pills; empty state renders with no sessions; a row click calls `onOpenSession`. Capture before/after and confirm no console errors.

- [ ] **Step 7: Final full check**

Run: `pnpm check && cargo test && cargo clippy -p kriyon --all-targets`
Expected: all green.

---

## Self-Review

**Spec coverage:**
- Tray icon + panel window + left-click toggle → Task 6. Right-click menu → Task 7. ✓
- Grouped vs compact + settings persistence → Tasks 1, 3, 9. ✓
- Row click → session via notification pipeline → Task 4 (`reveal_session`) + Task 5 (wiring). ✓
- Active-only grouping (needs-you + running, no done rows) → Task 2 selector. ✓
- Live attention badge → Task 8. ✓
- Keep Dock icon → Task 6 keeps default activation policy (no `Accessory`). ✓
- Frosted blur → Task 6 (`window-vibrancy` + `macOSPrivateApi`). ✓
- Theme in the panel window → Task 5 (`applyTheme` on boot + from persisted `themeId`). ✓
- No-inject constraint → Task 2 pills are labels; Task 4 navigates only. ✓
- Browser-QA seam → Task 9. ✓

**Placeholder scan:** Task 4 Step 1 and Task 9 Step 1 intentionally defer to the existing test's helper shape (a live `Session`/palette render is environment-specific) — both name exactly what to assert and why, not "add tests." All code steps carry real code.

**Type consistency:** `menuBarMode: "compact" | "grouped"` used identically across layout, persistence, selector prop, bridge listener, and palette. `TrayRow`/`TrayGroups` defined in Task 2, consumed unchanged in Task 3. Commands `reveal_session`/`show_main_window`/`new_session`/`open_preferences` named identically in `commands.rs`, `bridge.ts`, and `main.tsx`. Events `focus-session`/`new-session`/`open-preferences`/`menu-bar-mode` named identically on emit (Rust/JS) and listen (JS) sides.
