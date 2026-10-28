import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, expect, test, vi } from "vitest";

// Real bridge helpers stay (they no-op outside Tauri); only the git calls the
// sidebar's worktree indicators make are stubbed.
vi.mock("../ipc/bridge.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/bridge.ts")>();
  return {
    ...actual,
    activityDeleteSession: vi.fn(() => Promise.resolve()),
    removeWorktree: vi.fn(() => Promise.resolve()),
    repoStatus: vi.fn(() =>
      Promise.resolve({ ahead: 0, behind: 0, branch: "", dirtyCount: 0 })
    ),
    unmergedCommits: vi.fn(() => Promise.resolve(0)),
  };
});

// Only the hover prewarm is stubbed: it would open a real pty.
vi.mock("../state/actions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/actions.ts")>()),
  prewarmSession: vi.fn(() => Promise.resolve()),
}));

import {
  activityDeleteSession,
  removeWorktree,
  repoStatus,
  unmergedCommits,
} from "../ipc/bridge.ts";
import { prewarmSession } from "../state/actions.ts";
import { useChanges } from "../state/changes.ts";
import { useDrafts } from "../state/drafts.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSessionProposals } from "../state/nestedSessions.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { statusMeta } from "../theme/status.ts";
import { themeById } from "../theme/themes/index.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow, TaskStatus } from "../types.ts";
import { Toast } from "../ui/Toast.tsx";
import { PREWARM_DWELL_MS, SessionRow } from "./SessionRow.tsx";
import { Sidebar } from "./Sidebar.tsx";

/** The rail's empty-state copy, as one top-level matcher. */
const EMPTY_HINT = /No open sessions/;

function makeProject(id: string): ProjectRow {
  return {
    color: null,
    id,
    name: `Project ${id}`,
    path: `/${id}`,
    setupCommand: null,
  };
}

beforeEach(() => {
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    appendSeq: {},
    hooksOff: {},
    events: {},
    projects: [],
    sessions: {},
    touchedFiles: {},
    viewed: {},
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useDrafts.setState({ drafts: {} });
  useChanges.setState((state) => ({
    ...state,
    dirtyFiles: {},
    fileDrafts: {},
  }));
});

function seed(): void {
  const state = useSessions.getState();
  state.addProject(makeProject("p1"));
  state.addProject(makeProject("p2"));
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id: "s1",
    projectId: "p1",
    status: "running",
    summary: "$ cargo build",
    title: "Session One",
    titleLocked: false,
    worktreePath: null,
  });
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 2,
    cwd: "",
    id: "s2",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "Session Two",
    titleLocked: false,
    worktreePath: null,
  });
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 3,
    cwd: "",
    id: "s3",
    projectId: "p2",
    status: "done",
    summary: "",
    title: "Session Three",
    titleLocked: false,
    worktreePath: null,
  });
}

test("renders a group per project and a row per session", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("Project p1")).toBeInTheDocument();
  expect(screen.getByText("Project p2")).toBeInTheDocument();

  expect(screen.getAllByTestId("project-group")).toHaveLength(2);
  expect(screen.getAllByTestId("session-row")).toHaveLength(3);
});

test("session rows render draggable attributes inside a project group", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const rows = screen.getAllByTestId("session-row");
  expect(rows.length).toBeGreaterThan(0);
  // dnd-kit stamps sortable rows with aria-roledescription; the row div
  // itself carries none of dnd-kit's attributes — the drag activator (and
  // its aria) live on the row's grip handle (see SessionRow).
  const grip = rows[0]?.querySelector('[data-testid^="drag-handle-"]');
  expect(grip?.getAttribute("aria-roledescription")).toBe("sortable");
});

test("dnd-kit's focus/aria plumbing stays stripped from sortable rows", () => {
  // Regression guard for the dead-tab-stop fix: dnd-kit computes these
  // attributes regardless of `disabled`; SessionRow must keep them off.
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const row = screen.getAllByTestId("session-row")[0] as HTMLElement;
  expect(row.getAttribute("role")).toBeNull();
  expect(row.getAttribute("tabindex")).toBe("-1");
  expect(row.getAttribute("aria-pressed")).toBeNull();
  expect(row.getAttribute("aria-disabled")).toBeNull();
  expect(row.getAttribute("aria-describedby")).toBeNull();
});

test("rows stop announcing 'sortable' while a filter is active", () => {
  // Filtering disables drag (a drop on a subset would corrupt the saved
  // order), so the drag affordance must not be announced either.
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(screen.getByLabelText("Filter sessions"), {
    target: { value: "session" },
  });
  for (const row of screen.getAllByTestId("session-row")) {
    expect(row.getAttribute("aria-roledescription")).toBeNull();
  }
});

test("project headers expose a drag grip that announces 'sortable'", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const grip = screen.getByTestId("project-drag-handle-p1");
  expect(grip.getAttribute("aria-roledescription")).toBe("sortable");
});

test("the project grip stops announcing 'sortable' while filtering", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(screen.getByLabelText("Filter sessions"), {
    target: { value: "session" },
  });
  expect(
    screen
      .getByTestId("project-drag-handle-p1")
      .getAttribute("aria-roledescription")
  ).toBeNull();
});

test("the Rename project action renames the project in place", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("rename-project-menu-p1"));
  const input = screen.getByTestId("rename-project-p1") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Renamed Repo" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(useSessions.getState().projects.find((p) => p.id === "p1")?.name).toBe(
    "Renamed Repo"
  );
  expect(screen.getByText("Renamed Repo")).toBeInTheDocument();
});

test("double-clicking a session title renames it and locks the title", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.doubleClick(screen.getByLabelText("Open Session One"));
  const input = screen.getByTestId("rename-session-s1") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "My session" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const session = useSessions.getState().sessions.s1;
  expect(session?.title).toBe("My session");
  expect(session?.titleLocked).toBe(true);

  // A later Claude ai-title must not clobber the user's name.
  act(() => {
    useSessions.getState().applyTitle("s1", "Auto title");
  });
  expect(useSessions.getState().sessions.s1?.title).toBe("My session");
});

test("Escape cancels a session rename without changing the title", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.doubleClick(screen.getByLabelText("Open Session One"));
  const input = screen.getByTestId("rename-session-s1") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Discarded" } });
  fireEvent.keyDown(input, { key: "Escape" });

  expect(useSessions.getState().sessions.s1?.title).toBe("Session One");
  expect(useSessions.getState().sessions.s1?.titleLocked).toBeFalsy();
});

test("orders sessions newest-first within a project", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const group = screen
    .getByText("Project p1")
    .closest('[data-testid="project-group"]') as HTMLElement;
  const rows = within(group).getAllByTestId("session-row");
  // s2 (createdAt 2) is newer than s1 (createdAt 1), so it sits on top.
  expect(rows[0]).toHaveTextContent("Session Two");
  expect(rows[1]).toHaveTextContent("Session One");
});

test("clicking a session row calls setActiveSession with that id", () => {
  seed();
  const spy = vi.spyOn(useSessions.getState(), "setActiveSession");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // The visible text is a click-through layer; the full-bleed overlay button is
  // the select target (covers the whole row so an off-by-a-few-px click can't
  // miss into the padding — the macOS WKWebView two-click bug).
  fireEvent.click(screen.getByRole("button", { name: "Open Session Three" }));

  expect(spy).toHaveBeenCalledWith("s3");
});

test("returns to the terminal when a session is selected from the sidebar", () => {
  seed();
  useLayout.getState().setTranscriptView("changes");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Open Session Two" }));

  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("pressing a session row (pointerdown) does not select it", () => {
  // Selection fires on click only: the row is also the drag handle, and a press
  // that begins a drag must not open the session it grabbed (SessionRow's
  // rowSelectStyle).
  seed();
  const spy = vi.spyOn(useSessions.getState(), "setActiveSession");
  // spyOn hands back the earlier test's spy, calls and all.
  spy.mockClear();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Open Session Three" })
  );

  expect(spy).not.toHaveBeenCalled();
});

test("the active session row is marked active", () => {
  seed();
  useSessions.getState().setActiveSession("s2");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const rows = screen.getAllByTestId("session-row");
  const activeRow = rows.find(
    (row) => row.getAttribute("data-active") === "true"
  );
  expect(activeRow).toBeDefined();
  expect(activeRow).toHaveTextContent("Session Two");
  // Active rows take a neutral raised fill (accent stays on the bar/status).
  expect(activeRow?.style.getPropertyValue("--kr-row-bg")).toBe(
    tokens.color.surface.s3
  );
});

test("the new-session button invokes the onNewSession callback", () => {
  seed();
  const onNewSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={onNewSession}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "New session" }));

  expect(onNewSession).toHaveBeenCalledTimes(1);
});

test("clicking a row's close button calls onCloseSession and not setActiveSession", () => {
  seed();
  // Pin the active session so we can assert the close click did not change it.
  useSessions.getState().setActiveSession("s1");
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("close-session-s3"));

  expect(onCloseSession).toHaveBeenCalledWith("s3");
  // stopPropagation prevents the row's onClick (which would select s3).
  expect(useSessions.getState().activeSessionId).toBe("s1");
});

test("closing a session with an unsent draft shows a confirm, and cancel keeps it open", () => {
  seed();
  useDrafts.getState().setDraft("s1", "finish this thought");
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("close-session-s1"));

  expect(onCloseSession).not.toHaveBeenCalled();
  expect(screen.getByTestId("confirm-close-session")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(onCloseSession).not.toHaveBeenCalled();
  expect(screen.queryByTestId("confirm-close-session")).not.toBeInTheDocument();
});

test("confirming the unsent-work dialog closes the session", () => {
  seed();
  useDrafts.getState().setDraft("s1", "finish this thought");
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("close-session-s1"));
  fireEvent.click(screen.getByTestId("confirm-close-session"));

  expect(onCloseSession).toHaveBeenCalledWith("s1");
  expect(screen.queryByTestId("confirm-close-session")).not.toBeInTheDocument();
});

test("closing a session with unsaved file edits shows the same confirm", () => {
  seed();
  useChanges.getState().setDirtyFile("s1", "src/a.ts");
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("close-session-s1"));

  expect(onCloseSession).not.toHaveBeenCalled();
  expect(screen.getByTestId("confirm-close-session")).toBeInTheDocument();
});

test("a quiet, clean session (idle, no draft, no dirty file) closes with no dialog", () => {
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // s2 is idle. (s1 is mid-turn, which now asks first — see the next test.)
  fireEvent.click(screen.getByTestId("close-session-s2"));

  expect(onCloseSession).toHaveBeenCalledWith("s2");
  expect(screen.queryByTestId("confirm-close-session")).not.toBeInTheDocument();
});

// Closing ends the session's whole process tree, so a turn in flight is lost
// with it. That must never happen to an accidental click.
test("closing a session that is mid-task asks first, and says it stops something", () => {
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("close-session-s1"));

  expect(onCloseSession).not.toHaveBeenCalled();
  expect(screen.getByTestId("confirm-close-session")).toHaveTextContent(
    "Stop and close"
  );

  fireEvent.click(screen.getByTestId("confirm-close-session"));
  expect(onCloseSession).toHaveBeenCalledWith("s1");
});

test("renders a usage footer placeholder", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByTestId("sidebar-footer")).toBeInTheDocument();
});

test("the sidebar footer gear opens the Settings view", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("open-settings"));

  expect(useLayout.getState().layout.view).toBe("settings");
});

test("renders a session row's progress summary", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("$ cargo build")).toBeInTheDocument();
});

test("a project with a waiting child shows the rollup indicator", () => {
  seed();
  // Put a p2 session into the waiting state.
  useSessions.getState().applyStatus("s3", "waiting", "Waiting for your reply");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const groups = screen.getAllByTestId("project-group");
  const headers = groups.map((group) =>
    group.querySelector("[data-needs-attention]")
  );
  const attentionHeaders = headers.filter(
    (header) => header?.getAttribute("data-needs-attention") === "true"
  );
  expect(attentionHeaders).toHaveLength(1);
  expect(attentionHeaders[0]).toHaveTextContent("Project p2");
  expect(screen.getAllByTestId("rollup-dot")).toHaveLength(1);
});

test("an archived-but-waiting session does not trigger the rollup indicator", () => {
  seed();
  useSessions.getState().applyStatus("s3", "waiting", "Waiting for your reply");
  useSessions.getState().archiveSession("s3");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryAllByTestId("rollup-dot")).toHaveLength(0);
});

test("a session row re-renders on its own status tick, not another session's", () => {
  seed();
  let renders = 0;
  render(
    <Profiler
      id="row"
      onRender={() => {
        renders += 1;
      }}
    >
      <SessionRow
        mode="calm"
        onCloseSession={vi.fn()}
        onSelect={vi.fn()}
        sessionId="s1"
        sortable={false}
      />
    </Profiler>
  );
  const afterMount = renders;

  // A different session's tick must not re-render s1's row (narrow selectors).
  act(() => {
    useSessions.getState().applyStatus("s2", "running", "busy");
  });
  expect(renders).toBe(afterMount);

  // s1's own change does re-render its row.
  act(() => {
    useSessions.getState().applyStatus("s1", "waiting", "Waiting");
  });
  expect(renders).toBe(afterMount + 1);
});

test("a session row re-renders on its own event, not another session's event", () => {
  seed();
  let renders = 0;
  render(
    <Profiler
      id="row"
      onRender={() => {
        renders += 1;
      }}
    >
      <SessionRow
        mode="calm"
        onCloseSession={vi.fn()}
        onSelect={vi.fn()}
        sessionId="s1"
        sortable={false}
      />
    </Profiler>
  );
  const afterMount = renders;

  act(() => {
    useSessions.getState().appendEvent("s2", {
      id: "e1",
      kind: "assistant",
      text: "other",
    });
  });
  expect(renders).toBe(afterMount);
});

test("uses the status color for the session status dot", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const dot = screen.getByTestId("status-dot-s1");
  // s1 is "running"; the dot resolves through the themed status variable, and
  // every shipped theme keeps "running" green.
  expect(dot.style.background).toBe(tokens.color.status.running);
  expect(themeById("steel").colors.statusRunning).toBe("#3fb950");
});

test("a session with hooks off shows a neutral dot, not its stale status", () => {
  seed();
  useSessions.getState().applyHooksOff("s1", "user");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // s1 is "running", but nothing can retire that status any more (ADR-0029).
  expect(screen.getByTestId("status-unknown-s1")).toBeInTheDocument();
  expect(screen.queryByTestId("status-dot-s1")).not.toBeInTheDocument();
});

test("a done session shows a quiet ✓ instead of a status dot", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // s3 is "done": the ✓ carries the state, so it has no colored status dot.
  expect(screen.getByTestId("done-check-s3")).toBeInTheDocument();
  expect(screen.queryByTestId("status-dot-s3")).not.toBeInTheDocument();
});

/** Point s1's cwd at a real (mock-controlled) repo path so the badge's own
 * dirty check — keyed on that path via `repoStatus` — has something to
 * resolve. `seed()` leaves every session's `cwd` as `""`, which is a valid
 * "no repo yet" sentinel elsewhere but leaves the dirty check permanently
 * inert; the badge tests need a real path to drive dirty/clean explicitly. */
function pointS1At(cwd: string): void {
  useSessions.setState((state) => ({
    sessions: { ...state.sessions, s1: { ...state.sessions.s1, cwd } },
  }));
}

test("shows a files-changed badge with the touched-file count", async () => {
  seed();
  pointS1At("/repo-badge-count-1");
  vi.mocked(repoStatus).mockImplementation((path) =>
    Promise.resolve({
      ahead: 0,
      behind: 0,
      branch: "",
      dirtyCount: path === "/repo-badge-count-1" ? 1 : 0,
    })
  );
  useSessions.setState({ touchedFiles: { s1: ["/repo/src/a.ts"] } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(await screen.findByTestId("files-changed-badge-s1")).toHaveTextContent(
    "1"
  );
});

test("the files-changed badge counts every touched file for the session", async () => {
  seed();
  pointS1At("/repo-badge-count-3");
  vi.mocked(repoStatus).mockImplementation((path) =>
    Promise.resolve({
      ahead: 0,
      behind: 0,
      branch: "",
      dirtyCount: path === "/repo-badge-count-3" ? 1 : 0,
    })
  );
  useSessions.setState({
    touchedFiles: {
      s1: ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
    },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(await screen.findByTestId("files-changed-badge-s1")).toHaveTextContent(
    "3"
  );
});

test("shows no files-changed badge for a session with no touched files", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(
    screen.queryByTestId("files-changed-badge-s1")
  ).not.toBeInTheDocument();
});

test("the files-changed badge's title says what it counts, not 'changed'", async () => {
  seed();
  pointS1At("/repo-badge-title");
  vi.mocked(repoStatus).mockImplementation((path) =>
    Promise.resolve({
      ahead: 0,
      behind: 0,
      branch: "",
      dirtyCount: path === "/repo-badge-title" ? 1 : 0,
    })
  );
  useSessions.setState({ touchedFiles: { s1: ["/repo/src/a.ts"] } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const badge = await screen.findByTestId("files-changed-badge-s1");
  expect(badge).toHaveAttribute("title", "1 file touched this session");
});

test("hides the files-changed badge once the working tree is clean, even though touchedFiles is still non-empty", async () => {
  // The failure this guards: the user commits everything Claude touched.
  // touchedFiles is never cleared (not on commit, not on undo), so the
  // badge must not go on claiming a count once the tree it's about is
  // actually clean — that's a live contradiction with the Changes view.
  seed();
  pointS1At("/repo-badge-clean");
  vi.mocked(repoStatus).mockImplementation((path) =>
    Promise.resolve({
      ahead: 0,
      behind: 0,
      branch: "",
      dirtyCount: path === "/repo-badge-clean" ? 0 : 0,
    })
  );
  useSessions.setState({ touchedFiles: { s1: ["/repo/src/a.ts"] } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // Give the (mocked, resolved) repoStatus fetch a tick to settle.
  await waitFor(() => expect(repoStatus).toHaveBeenCalled());
  expect(
    screen.queryByTestId("files-changed-badge-s1")
  ).not.toBeInTheDocument();
});

test("checks the worktree's dirty state once per row, not once for the dot and again for the badge", async () => {
  // Regression guard: FilesChangedBadge used to run its own useWorktreeDirty
  // subscription on the same path SessionRow already resolves for the dot,
  // so every status transition spawned two `git status` runs per row. The
  // fix computes dirty once in SessionRow and hands it down as a prop.
  vi.mocked(repoStatus).mockClear();
  vi.mocked(repoStatus).mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "feat-x",
    dirtyCount: 2,
  });
  seedWorktreeSession();
  useSessions.setState({ touchedFiles: { w1: ["/repo/src/a.ts"] } });
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="w1"
      sortable={false}
    />
  );

  await screen.findByTestId("files-changed-badge-w1");
  await screen.findByTestId("worktree-dirty-w1");
  expect(repoStatus).toHaveBeenCalledTimes(1);
});

test("shows the files-changed badge when the dirty check fails, instead of hiding it forever", async () => {
  // The failure this guards: a plain (non-git) working directory makes
  // `repoStatus` reject. Before this fix, `dirty` initialised to `false` and
  // only ever flipped on a *successful* fetch, so a permanently-failing
  // check left the badge hidden for the entire life of the session even
  // though touchedFiles has real entries.
  seed();
  pointS1At("/repo-badge-error");
  vi.mocked(repoStatus).mockImplementation((path) =>
    path === "/repo-badge-error"
      ? Promise.reject(new Error("fatal: not a git repository"))
      : Promise.resolve({ ahead: 0, behind: 0, branch: "", dirtyCount: 0 })
  );
  useSessions.setState({ touchedFiles: { s1: ["/repo/src/a.ts"] } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(await screen.findByTestId("files-changed-badge-s1")).toHaveTextContent(
    "1"
  );
});

test("triage folds read, finished sessions into a per-project summary", () => {
  seed();
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, sidebarMode: "triage" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // s3 (done, unread never marked → but no events, so it reads as seen) folds
  // away; the summary counts it and expanding reveals it.
  expect(screen.queryByText("Session Three")).not.toBeInTheDocument();
  const summary = screen.getByTestId("done-summary-p2");
  expect(summary).toHaveTextContent("1 done");

  fireEvent.click(summary);
  expect(screen.getByText("Session Three")).toBeInTheDocument();
});

test("triage floats a project needing attention above an earlier one", () => {
  const state = useSessions.getState();
  state.addProject(makeProject("p1"));
  state.addProject(makeProject("p2"));
  // "Project p1" only has a finished session; "Project p2" is blocked.
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id: "done1",
    projectId: "p1",
    status: "done",
    summary: "",
    title: "Finished",
    titleLocked: false,
    worktreePath: null,
  });
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 2,
    cwd: "",
    id: "wait1",
    projectId: "p2",
    status: "waiting",
    summary: "",
    title: "Blocked",
    titleLocked: false,
    worktreePath: null,
  });
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, sidebarMode: "triage" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const groups = screen.getAllByTestId("project-group");
  // p2 needs the user, so it floats over the alphabetically-first p1.
  expect(within(groups[0]).getByText("Project p2")).toBeInTheDocument();
});

test("triage tags an unread finished session with a new badge", () => {
  seed();
  // Events appended to s3, never viewed → it reads as unseen work.
  useSessions.setState({ appendSeq: { s3: 2 }, viewed: {} });
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, sidebarMode: "triage" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // Unseen Done stays a visible row (the ✓ testid is row-only, unlike the
  // shared title) and carries the badge, rather than folding into a summary.
  expect(screen.getByTestId("done-check-s3")).toBeInTheDocument();
  expect(screen.getByTestId("new-badge-s3")).toBeInTheDocument();
  expect(screen.queryByTestId("done-summary-p2")).not.toBeInTheDocument();
});

test("calm never shows the new badge, even for unread finished work", () => {
  seed();
  useSessions.setState({ appendSeq: { s3: 2 }, viewed: {} });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByTestId("done-check-s3")).toBeInTheDocument();
  expect(screen.queryByTestId("new-badge-s3")).not.toBeInTheDocument();
});

const RE_PROJECT_P1 = /Project p1/;
const RE_SORT_SESSIONS_IN = /Sort sessions in /;

test("a project header shows its session count and collapses its group", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // Both the disclosure and the per-project "+" carry the project name; the
  // disclosure is the one with aria-expanded.
  const header = screen
    .getAllByRole("button", { name: RE_PROJECT_P1 })
    .find((button) => button.hasAttribute("aria-expanded"));
  if (!header) {
    throw new Error("missing project disclosure button");
  }
  expect(header).toHaveAttribute("aria-expanded", "true");
  // The count is a rollup pinned to the rail's right edge — a sibling of the
  // disclosure, not part of its label, so the hover actions can float over it
  // instead of reserving width between it and the edge.
  expect(screen.getByTestId("session-count-p1")).toHaveTextContent("2");
  expect(screen.getAllByTestId("session-row")).toHaveLength(3);

  fireEvent.click(header);

  // p1's two rows (and its history affordance) are gone; p2's row remains.
  expect(screen.getAllByTestId("session-row")).toHaveLength(1);
  expect(screen.getAllByTestId("earlier-sessions")).toHaveLength(1);
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(useLayout.getState().layout.collapsedProjectIds).toEqual(["p1"]);
});

test("a collapsed project still surfaces its attention rollup", () => {
  seed();
  useSessions.getState().applyStatus("s3", "waiting", "Waiting for your reply");
  useLayout.getState().toggleProjectCollapsed("p2");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getAllByTestId("rollup-dot")).toHaveLength(1);
});

test("a waiting session row is tinted and reads needs-input", () => {
  seed();
  useSessions.getState().applyStatus("s2", "waiting", "");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const waiting = screen
    .getAllByTestId("session-row")
    .find((row) => row.getAttribute("data-status") === "waiting");
  expect(waiting).toHaveTextContent("Session Two");
  expect(waiting).toHaveTextContent("Needs your input");
  // The fill is a custom property, not an inline background: an inline one
  // outranks the hover rule, which is what left washed rows hoverless.
  expect(waiting?.style.getPropertyValue("--kr-row-bg")).toBe(
    statusMeta("waiting").wash
  );
  // …and hovering deepens the same amber rather than washing it out white.
  expect(waiting?.style.getPropertyValue("--kr-row-hover")).toBe(
    statusMeta("waiting").soft
  );
});

test("a session row shows the live tool instead of the stale summary", () => {
  seed();
  useSessions.getState().applyActivity("s1", {
    main: {
      currentTool: { startedAt: null, target: "/x/pty.rs", toolName: "Edit" },
    },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("Editing pty.rs")).toBeInTheDocument();
  expect(screen.queryByText("$ cargo build")).not.toBeInTheDocument();
});

test("a worktree session shows its worktree name", () => {
  seed();
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 4,
    cwd: "/wt/feat-flow",
    id: "s4",
    projectId: "p2",
    status: "idle",
    summary: "",
    title: "Worktree session",
    titleLocked: false,
    worktreePath: "/wt/feat-flow",
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("feat-flow")).toBeInTheDocument();
});

test("the close button is hover-revealed", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(
    screen.getByTestId("close-session-s1").closest(".kr-reveal-cluster")
  ).not.toBeNull();
});

const RE_HISTORY = /History/;
/** The merged row when nothing is folded — history and nothing else. */
const RE_COMPACT_AGE = /^\d+(m|h|d|mo|y)$/;
const RE_HISTORY_ONLY = /^history$/i;
const RE_HISTORY_HALF = /history/i;

test("each project offers a quiet History affordance", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getAllByText(RE_HISTORY)).toHaveLength(2);
});

test("the Needs-you section lists blocked sessions and opens one on click", () => {
  seed();
  useSessions.getState().applyStatus("s2", "waiting", "");
  useSessions.getState().applyStatus("s3", "error", "boom");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const section = screen.getByTestId("needs-you-section");
  expect(section).toHaveTextContent("2");
  expect(within(section).getByTestId("needs-you-s2")).toHaveAttribute(
    "data-kind",
    "waiting"
  );
  expect(within(section).getByTestId("needs-you-s3")).toHaveAttribute(
    "data-kind",
    "error"
  );

  fireEvent.click(
    within(section).getByRole("button", { name: "Go to Session Two" })
  );
  expect(useSessions.getState().activeSessionId).toBe("s2");
});

test("an exact question is highlighted apart from a plain wait", () => {
  seed();
  useSessions.getState().applyStatus("s1", "waiting", "");
  useSessions.getState().applyStatus("s2", "waiting", "");
  useSessions.getState().applyActivity("s1", {
    main: { currentTool: null },
    pendingAsk: {
      askedAt: null,
      kind: "question",
      text: "Merge or rebase this branch?",
    },
    shells: [],
    subagents: [],
    tasks: [],
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const question = screen.getByTestId("needs-you-s1");
  expect(question).toHaveAttribute("data-kind", "question");
  // The question's own words show in the row, and it gets the tinted wash.
  expect(question).toHaveTextContent("Merge or rebase this branch?");
  expect(question.style.getPropertyValue("--kr-row-bg")).toBe(
    statusMeta("waiting").wash
  );
  // A plain wait stays quiet: no wash, no ask line.
  expect(
    screen.getByTestId("needs-you-s2").style.getPropertyValue("--kr-row-bg")
  ).toBe("transparent");
  // Questions sort above plain waits regardless of creation order.
  const rows = within(screen.getByTestId("needs-you-section")).getAllByRole(
    "button"
  );
  expect(rows[0]).toHaveAttribute("data-testid", "needs-you-s1");
});

test("a permission ask keeps the question treatment but its own icon kind", () => {
  seed();
  useSessions.getState().applyStatus("s1", "waiting", "");
  useSessions.getState().applyActivity("s1", {
    main: { currentTool: null },
    pendingAsk: {
      askedAt: null,
      kind: "permission",
      text: "Allow Bash to run pnpm check?",
    },
    shells: [],
    subagents: [],
    tasks: [],
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const row = screen.getByTestId("needs-you-s1");
  expect(row).toHaveAttribute("data-kind", "question");
  expect(row).toHaveAttribute("data-ask-kind", "permission");
});

test("a finished session reads as complete until the user views it", () => {
  seed();
  useSessions.getState().setActiveSession("s1");
  // s3 is "done" and produces output the user has not seen.
  useSessions.getState().appendEvent("s3", {
    id: "e1",
    kind: "assistant",
    text: "All green.",
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByTestId("needs-you-s3")).toHaveAttribute(
    "data-kind",
    "done"
  );

  fireEvent.click(screen.getByRole("button", { name: "Go to Session Three" }));

  expect(useSessions.getState().activeSessionId).toBe("s3");
  expect(screen.queryByTestId("needs-you-s3")).not.toBeInTheDocument();
});

test("the Needs-you section is absent when nothing qualifies", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByTestId("needs-you-section")).not.toBeInTheDocument();
});

test("an archived-but-waiting session does not appear in the Needs-you section", () => {
  seed();
  useSessions.getState().applyStatus("s2", "waiting", "");
  useSessions.getState().archiveSession("s2");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByTestId("needs-you-section")).not.toBeInTheDocument();
});

test("a project header's + starts a session in that project right away", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(
    screen.getByRole("button", { name: "New session in Project p1" })
  );

  const created = Object.values(useSessions.getState().sessions).find(
    (session) => session.cwd === "/p1"
  );
  expect(created).toBeDefined();
  expect(created?.projectId).toBe("p1");
  expect(useSessions.getState().activeSessionId).toBe(created?.id);
});

test("a project header's worktree action opens the guided dialog", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(
    screen.getByRole("button", {
      name: "New worktree session in Project p1",
    })
  );

  // Worktrees need a branch name and an explanation — no instant create.
  const ui = useUi.getState();
  expect(ui.spawnOpen).toBe(true);
  expect(ui.spawnPredecessorId).toBeNull();
  expect(ui.spawnProjectId).toBe("p1");
  expect(ui.spawnWorktreeDefault).toBe(true);
});

test("a project's sessions and history sit in one indented subtree", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const children = screen.getAllByTestId("project-children");
  expect(children).toHaveLength(2);
  // Indentation alone carries the hierarchy (design 5a/5b) — no tree guide.
  // The container inset matches the header's leading drag-grip column so the
  // subtree stays flush under the project name (see groupChildrenStyle).
  expect(children[0].style.paddingLeft).toBe("15px");
  expect(children[0].style.borderLeft).toBe("");
  // History lives inside the subtree, indented like the session rows.
  expect(
    within(children[0]).getByTestId("earlier-sessions")
  ).toBeInTheDocument();
});

/**
 * Sum the leading horizontal space a row's own columns contribute before its
 * text: the container's inset, each ancestor's left padding, and every fixed
 * sibling (glyph slots, gaps) the label sits behind. jsdom has no layout, so
 * this reads the declared style values rather than a rect — enough to pin the
 * arithmetic, which is what actually drifts.
 */
function leadingInset(px: (value: string) => number, parts: string[]): number {
  return parts.reduce((total, value) => total + px(value), 0);
}

test("session titles line up with their project name, not indented past it", () => {
  // The one rule the 5a/5b sidebar rests on: a session title sits flush under
  // its project name, with only the status glyph hanging into the gutter. The
  // header's chevron+swatch columns and the row's grip+glyph columns are
  // independent numbers that must sum to the same inset — nothing else in the
  // suite notices when a gap, a grip width, or an icon size drifts.
  const px = (value: string) => Number.parseFloat(value) || 0;

  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // Header: drag grip + header gap + button padding + chevron + gap + swatch +
  // gap. The grip is the header's leading column, before the disclosure button.
  const header = screen
    .getAllByRole("button", { name: RE_PROJECT_P1 })
    .find((button) => button.hasAttribute("aria-expanded"));
  if (!header) {
    throw new Error("missing project disclosure button");
  }
  const headerStyle = header.style;
  const headerContainer = header.parentElement as HTMLElement;
  const grip = screen.getByTestId("project-drag-handle-p1");
  const headerInset = leadingInset(px, [
    grip.style.width, // PROJECT_GRIP_WIDTH
    headerContainer.style.gap, // header flex gap before the button
    headerStyle.paddingLeft,
    "9", // ChevronRight size={9}
    headerStyle.gap,
    "8", // colorSquareStyle width
    headerStyle.gap,
  ]);

  // Row: container inset + row padding + grip slot + gap + glyph + gap.
  const [children] = screen.getAllByTestId("project-children");
  const [row] = within(children).getAllByTestId("session-row");
  const content = row.firstElementChild?.nextElementSibling as HTMLElement;
  const rowInset = leadingInset(px, [
    children.style.paddingLeft,
    row.style.paddingLeft,
    "12", // GRIP_SLOT
    content.style.gap,
    "7", // status glyph column
    content.style.gap,
  ]);

  expect(rowInset).toBe(headerInset);
});

test("a project's hover palette action recolors it and can return to automatic", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Change color of Project p1" })
  );
  fireEvent.click(screen.getByTestId("swatch-#a293e8"));

  expect(
    useSessions.getState().projects.find((p) => p.id === "p1")?.color
  ).toBe("#a293e8");
  // Picking a color closes the popover.
  expect(screen.queryByTestId("swatch-#a293e8")).not.toBeInTheDocument();

  // "Automatic" clears the explicit color back to the hashed palette hue.
  fireEvent.click(
    screen.getByRole("button", { name: "Change color of Project p1" })
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Automatic color" }));
  expect(
    useSessions.getState().projects.find((p) => p.id === "p1")?.color
  ).toBeNull();
});

test("the color popover dismisses on Escape and on clicking elsewhere", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );
  const trigger = screen.getByRole("button", {
    name: "Change color of Project p1",
  });

  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByTestId("swatch-#a293e8")).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByTestId("swatch-#a293e8")).not.toBeInTheDocument();
});

test("swatches carry human color names and a checked state", () => {
  seed();
  useSessions.getState().setProjectColor("p1", "#a293e8");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Change color of Project p1" })
  );

  const selected = screen.getByRole("menuitemradio", {
    name: "Set color violet",
  });
  expect(selected).toHaveAttribute("aria-checked", "true");
  expect(
    screen.getByRole("menuitemradio", { name: "Set color blue" })
  ).toHaveAttribute("aria-checked", "false");
});

test("the noisy Workspaces label is gone", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByText("Workspaces")).not.toBeInTheDocument();
});

test("the sidebar takes its width from layout state", () => {
  seed();
  useLayout.getState().setSidebarWidth(320);
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByRole("complementary").style.flexBasis).toBe("320px");
});

test("dragging the resize handle updates the persisted width", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const handle = screen.getByTestId("sidebar-resize");
  fireEvent.mouseDown(handle, { clientX: 278 });
  fireEvent.mouseMove(window, { clientX: 340 });
  fireEvent.mouseUp(window);

  expect(useLayout.getState().layout.sidebarWidth).toBe(340);

  // After release, further movement must not resize.
  fireEvent.mouseMove(window, { clientX: 500 });
  expect(useLayout.getState().layout.sidebarWidth).toBe(340);
});

test("double-clicking the resize handle resets the default width", () => {
  seed();
  useLayout.getState().setSidebarWidth(360);
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.doubleClick(screen.getByTestId("sidebar-resize"));

  expect(useLayout.getState().layout.sidebarWidth).toBe(278);
});

test("projects without open sessions are hidden", () => {
  seed();
  useSessions.getState().addProject(makeProject("p9"));
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByText("Project p9")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("project-group")).toHaveLength(2);
});

test("projects sort alphabetically regardless of creation order", () => {
  seed();
  useSessions.getState().addProject({
    color: null,
    id: "zz",
    name: "Alpha",
    path: "/zz",
    setupCommand: null,
  });
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 9,
    cwd: "/zz",
    id: "s9",
    projectId: "zz",
    status: "idle",
    summary: "",
    title: "Alpha session",
    titleLocked: false,
    worktreePath: null,
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const groups = screen.getAllByTestId("project-group");
  expect(groups[0]).toHaveTextContent("Alpha");
});

test("a stale idle session folds under a 'N older — show' disclosure", () => {
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
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: now - 1000,
        cwd: "",
        id: "fresh",
        projectId,
        status: "idle",
        summary: "",
        title: "Fresh",
        titleLocked: false,
        worktreePath: null,
      },
      stale: {
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: now - 5 * 86_400_000,
        cwd: "",
        id: "stale",
        projectId,
        status: "idle",
        summary: "",
        title: "Stale one",
        titleLocked: false,
        worktreePath: null,
      },
    },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // The stale row is hidden until the disclosure is opened.
  expect(screen.queryByText("Stale one")).not.toBeInTheDocument();
  const olderToggle = screen.getByTestId(`older-summary-${projectId}`);
  fireEvent.click(olderToggle);
  expect(screen.getByText("Stale one")).toBeInTheDocument();
});

test("an empty sidebar shows a quiet start hint", () => {
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(
    screen.getByText("No open sessions.", { exact: false })
  ).toBeInTheDocument();
});

function filterInput(): HTMLElement {
  // Queried by its accessible name, not its placeholder: the placeholder is
  // now the canvas's "Search…" while the box still filters the rail.
  return screen.getByLabelText("Filter sessions");
}

test("typing in the filter narrows rows and hides matchless projects", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(filterInput(), { target: { value: "two" } });

  expect(screen.getAllByTestId("session-row")).toHaveLength(1);
  expect(screen.getByText("Session Two")).toBeInTheDocument();
  expect(screen.queryByText("Project p2")).not.toBeInTheDocument();
});

test("a project-name match keeps all of that project's sessions", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(filterInput(), { target: { value: "project p2" } });

  expect(screen.getByText("Session Three")).toBeInTheDocument();
  expect(screen.queryByText("Session One")).not.toBeInTheDocument();
});

test("filtering searches collapsed projects and hides history", () => {
  seed();
  useLayout.getState().toggleProjectCollapsed("p1");
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(filterInput(), { target: { value: "one" } });

  expect(screen.getByText("Session One")).toBeInTheDocument();
  expect(screen.queryByTestId("earlier-sessions")).not.toBeInTheDocument();
});

test("Escape clears the filter", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(filterInput(), { target: { value: "two" } });
  fireEvent.keyDown(filterInput(), { key: "Escape" });

  expect(screen.getAllByTestId("session-row")).toHaveLength(3);
});

test("the row overflow menu dismisses on Escape and outside press, with aria", () => {
  seed();
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="s1"
      sortable={false}
    />
  );
  const trigger = screen.getByTestId("session-menu-s1");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");

  // Opening flips aria-expanded and reveals the menu.
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("spawn-followup-s1")).toBeInTheDocument();
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByTestId("spawn-followup-s1")).toHaveAttribute(
    "role",
    "menuitem"
  );

  // Escape dismisses it.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("spawn-followup-s1")).not.toBeInTheDocument();

  // An outside press dismisses it.
  fireEvent.click(trigger);
  expect(screen.getByTestId("spawn-followup-s1")).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByTestId("spawn-followup-s1")).not.toBeInTheDocument();
});

function seedSession(id: string, over: Partial<UiSession> = {}): void {
  const session: UiSession = {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1000,
    cwd: "",
    id,
    projectId: "p",
    status: "idle",
    summary: "",
    title: id,
    titleLocked: false,
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
  const grip = screen.getByTestId("drag-handle-s1");
  expect(grip).toBeInTheDocument();
  // RowPointerSensor (dragCommit.ts) refuses to start a drag from any
  // element matching `[data-no-dnd]` — a bare attribute-presence selector
  // that matches regardless of value. The grip is the row's only drag
  // activator, so it must never carry this attribute (not even "false"),
  // or dragging can never start.
  expect(grip).not.toHaveAttribute("data-no-dnd");
  // The row's full-bleed select button is position:absolute; without the
  // grip also being positioned, CSS paints the button above this
  // non-positioned in-flow sibling regardless of DOM order, swallowing the
  // pointerdown before dnd-kit's drag listeners see it (jsdom can't hit-test
  // paint order, so this pins the fix directly on the style).
  expect(grip).toHaveStyle({ position: "relative" });
  fireEvent.click(screen.getByRole("button", { name: "Open Fix login" }));
  expect(onSelect).toHaveBeenCalledWith("s1");
});

test("a follow-up row links back to its predecessor; clicking selects it", () => {
  seedSession("child", { parentSessionId: "parent", title: "Next step" });
  useSessions.setState((s) => ({
    sessions: {
      ...s.sessions,
      parent: {
        ...(s.sessions.child as UiSession),
        id: "parent",
        parentSessionId: null,
        title: "Big refactor",
      },
    },
  }));
  const onSelect = renderRow("child", false);
  const badge = screen.getByTestId("handoff-link-child");
  // The follow-up is listed above its predecessor, so the arrow points down.
  expect(badge).toHaveTextContent("↓ from Big refactor");
  // It reads as a link: a hover class and a tooltip saying where it goes.
  expect(badge).toHaveClass("kr-link");
  expect(badge).toHaveAttribute("title", "Go to “Big refactor”");
  fireEvent.click(badge);
  expect(onSelect).toHaveBeenCalledWith("parent");
  expect(onSelect).not.toHaveBeenCalledWith("child");
});

test("a row whose predecessor is gone shows no handoff link", () => {
  seedSession("orphan", { parentSessionId: "closed" });
  renderRow("orphan", false);
  expect(screen.queryByTestId("handoff-link-orphan")).not.toBeInTheDocument();
});

test("a non-sortable row renders no drag handle", () => {
  seedSession("s2", { title: "Old one" });
  renderRow("s2", false);
  expect(screen.queryByTestId("drag-handle-s2")).not.toBeInTheDocument();
});

/** Seed one worktree session into p1 alongside the plain ones. */
function seedWorktreeSession(status: "running" | "done" = "running"): void {
  seed();
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 4,
    cwd: "/p1-worktrees/feat-x",
    id: "w1",
    projectId: "p1",
    status,
    summary: "",
    title: "Worktree Session",
    titleLocked: false,
    worktreePath: "/p1-worktrees/feat-x",
  });
}

test("a project header counts its open worktree sessions", () => {
  seedWorktreeSession();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  const count = screen.getByTestId("worktree-count-p1");
  expect(count).toHaveTextContent("1");
  // A project without worktree sessions shows no count at all.
  expect(screen.queryByTestId("worktree-count-p2")).toBeNull();
});

test("a worktree row shows its branch and a dot for uncommitted changes", async () => {
  vi.mocked(repoStatus).mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "feat-x",
    dirtyCount: 2,
  });
  seedWorktreeSession();
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="w1"
      sortable={false}
    />
  );

  expect(screen.getByText("feat-x")).toBeInTheDocument();
  expect(await screen.findByTestId("worktree-dirty-w1")).toBeInTheDocument();
});

test("a worktree row whose commits aren't merged says so", async () => {
  vi.mocked(repoStatus).mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "feat-x",
    dirtyCount: 0,
  });
  vi.mocked(unmergedCommits).mockResolvedValue(2);
  seedWorktreeSession();
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="w1"
      sortable={false}
    />
  );
  const chip = await screen.findByTestId("worktree-unmerged-w1");
  expect(chip).toHaveTextContent("Not merged");
  // First on the meta line, which clips at the row's edge.
  expect(chip.parentElement?.firstElementChild).toBe(chip);
  vi.mocked(unmergedCommits).mockResolvedValue(0);
});

test("a worktree's warning clears after another session commits its work", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(repoStatus).mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "feat-x",
    dirtyCount: 1,
  });
  seedWorktreeSession("done");
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="w1"
      sortable={false}
    />
  );
  await screen.findByTestId("worktree-dirty-w1");
  // The lead commits it: this row's own status never changes.
  vi.mocked(repoStatus).mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "feat-x",
    dirtyCount: 0,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(screen.queryByTestId("worktree-dirty-w1")).not.toBeInTheDocument();
  vi.useRealTimers();
});

test("removing a clean worktree archives the session", async () => {
  vi.mocked(removeWorktree).mockResolvedValue();
  seedWorktreeSession("done");
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="w1"
      sortable={false}
    />
  );

  fireEvent.click(screen.getByTestId("session-menu-w1"));
  fireEvent.click(screen.getByTestId("remove-worktree-w1"));

  await waitFor(() => {
    expect(useSessions.getState().sessions.w1?.archivedAt).toBeGreaterThan(0);
  });
  expect(removeWorktree).toHaveBeenCalledWith("/p1", "/p1-worktrees/feat-x");
});

test("a dirty worktree asks for confirmation before a forced removal", async () => {
  // Plain removal refused (git's dirty-tree error), forced removal succeeds.
  vi.mocked(removeWorktree)
    .mockRejectedValueOnce(new Error("contains modified or untracked files"))
    .mockResolvedValueOnce(undefined);
  seedWorktreeSession("done");
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="w1"
      sortable={false}
    />
  );

  fireEvent.click(screen.getByTestId("session-menu-w1"));
  fireEvent.click(screen.getByTestId("remove-worktree-w1"));

  // The refusal surfaces a confirm instead of silently forcing.
  const confirm = await screen.findByTestId("confirm-remove-worktree-w1");
  expect(confirm.textContent).toContain("Uncommitted changes");
  expect(useSessions.getState().sessions.w1?.archivedAt).toBeNull();

  fireEvent.click(screen.getByTestId("confirm-remove-worktree-go-w1"));
  await waitFor(() => {
    expect(useSessions.getState().sessions.w1?.archivedAt).toBeGreaterThan(0);
  });
  expect(removeWorktree).toHaveBeenLastCalledWith(
    "/p1",
    "/p1-worktrees/feat-x",
    true
  );
});

test("the row overflow menu spawns a follow-up and archives", () => {
  seed();
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="s1"
      sortable={false}
    />
  );

  fireEvent.click(screen.getByTestId("session-menu-s1"));
  fireEvent.click(screen.getByTestId("spawn-followup-s1"));

  expect(useUi.getState().spawnOpen).toBe(true);
  expect(useUi.getState().spawnPredecessorId).toBe("s1");

  fireEvent.click(screen.getByTestId("session-menu-s1"));
  fireEvent.click(screen.getByTestId("archive-s1"));

  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
});

test("Delete activity asks first, then forgets the session's activity", async () => {
  seed();
  render(
    <SessionRow
      mode="calm"
      onCloseSession={vi.fn()}
      onSelect={vi.fn()}
      sessionId="s1"
      sortable={false}
    />
  );

  fireEvent.click(screen.getByTestId("session-menu-s1"));
  fireEvent.click(screen.getByTestId("delete-activity-s1"));
  fireEvent.click(screen.getByText("Cancel"));
  expect(activityDeleteSession).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("session-menu-s1"));
  fireEvent.click(screen.getByTestId("delete-activity-s1"));
  fireEvent.click(screen.getByTestId("confirm-delete-activity"));
  await waitFor(() => expect(activityDeleteSession).toHaveBeenCalledWith("s1"));
  expect(screen.queryByTestId("confirm-delete-activity")).toBeNull();
});

test("the sort button switches the global session sort", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("Sort sessions"));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));

  expect(useLayout.getState().layout.sessionSort).toBe("name");
  // Picking a global mode resets any per-project override.
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("a project sort override is set from the header and survives a Follow global", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getAllByLabelText(RE_SORT_SESSIONS_IN)[0]);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Manual" }));
  const overrides = () => useLayout.getState().layout.projectSortOverrides;
  expect(Object.values(overrides())).toEqual(["manual"]);

  // Verify the override mode is shown in the button title
  expect(
    screen.getAllByLabelText(RE_SORT_SESSIONS_IN)[0].getAttribute("title")
  ).toContain("Sorted by manual");

  fireEvent.click(screen.getAllByLabelText(RE_SORT_SESSIONS_IN)[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Follow global" }));
  expect(overrides()).toEqual({});
});

test("the global sort popover offers hide-older-than options that update layout", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("Sort sessions"));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "3 days" }));

  expect(useLayout.getState().layout.hideOlderThan).toBe("3d");
});

test("a sleeping row wears a moon", () => {
  seedSession("s1", { title: "Asleep" });
  act(() => {
    useSessions.setState({ sleeping: { s1: "asleep" } });
  });
  renderRow("s1", false);
  expect(screen.getByTestId("sleeping-moon-s1")).toBeInTheDocument();
  expect(screen.queryByTestId("sleeping-stuck-s1")).not.toBeInTheDocument();
});

test("a stuck row is marked apart from a sleeping one", () => {
  // `stuck` — Kriyon stopped the claude but could not resume it — must be
  // tellable from an ordinary sleeping row, or the only signal is stderr.
  seedSession("s2", { title: "Stuck" });
  act(() => {
    useSessions.setState({ sleeping: { s2: "stuck" } });
  });
  renderRow("s2", false);
  const stuck = screen.getByTestId("sleeping-stuck-s2");
  expect(stuck).toBeInTheDocument();
  expect(stuck).toHaveStyle({ color: tokens.color.status.error });
  expect(screen.queryByTestId("sleeping-moon-s2")).not.toBeInTheDocument();
});

test("a waking row shows a spinner, not a moon", () => {
  // `waking` — the resume is typed but claude is not confirmed back yet — must
  // read as loading, distinct from the static asleep moon.
  seedSession("s1", { title: "Waking" });
  act(() => {
    useSessions.setState({ sleeping: { s1: "waking" } });
  });
  renderRow("s1", false);
  expect(screen.getByTestId("waking-spinner-s1")).toBeInTheDocument();
  expect(screen.queryByTestId("sleeping-moon-s1")).not.toBeInTheDocument();
  expect(screen.queryByTestId("sleeping-stuck-s1")).not.toBeInTheDocument();
});

test("a booting row shows the same resume spinner", () => {
  // A fresh launch / resume-from-history is the same "loading" state as waking
  // a slept session, so the row shows the spinner while claude comes up.
  seedSession("s1", { title: "Booting" });
  act(() => {
    useSessions.setState({ bootPhase: { s1: "booting" } });
  });
  renderRow("s1", false);
  expect(screen.getByTestId("booting-spinner-s1")).toBeInTheDocument();
  expect(screen.queryByTestId("status-dot-s1")).not.toBeInTheDocument();
});

test("a row whose launch is still opening shows the same spinner", () => {
  seedSession("s1", { title: "Launching" });
  act(() => {
    useSessions.setState({ bootPhase: { s1: "launching" } });
  });
  renderRow("s1", false);
  expect(screen.getByTestId("booting-spinner-s1")).toBeInTheDocument();
});

test("an awake row wears no moon", () => {
  seedSession("s1", { title: "Awake" });
  act(() => {
    useSessions.setState({ sleeping: {} });
  });
  renderRow("s1", false);
  expect(screen.queryByTestId("sleeping-moon-s1")).not.toBeInTheDocument();
  expect(screen.queryByTestId("sleeping-stuck-s1")).not.toBeInTheDocument();
});

test("the memory chip colours against the user's budget, not a constant", () => {
  // The whole point of tying the chip to the [Memory budget]: the same 700 MB
  // reading is unremarkable at the 6 GB default but flagged at a 1 GB ceiling.
  // A row hardcoding the default budget (the bug the scaling change fixed)
  // would render the same tone in both and fail this.
  seedSession("s1", { title: "Heavy" });
  act(() => {
    useSessions.setState({ memory: { s1: 700 } });
  });

  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, memoryBudgetMb: 1024 },
  });
  renderRow("s1", false);
  expect(screen.getByText("700 MB")).toHaveStyle({
    color: tokens.color.status.error,
  });
  cleanup();

  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, memoryBudgetMb: 6144 },
  });
  renderRow("s1", false);
  expect(screen.getByText("700 MB")).not.toHaveStyle({
    color: tokens.color.status.error,
  });
});

test("the row shows the session's CPU beside its memory, a dash before two samples", () => {
  seedSession("s1", { title: "Busy" });
  act(() => {
    useSessions.setState({ cpu: {}, memory: { s1: 300 } });
  });
  renderRow("s1", false);
  expect(screen.getByTestId("cpu-chip-s1")).toHaveTextContent("—");
  cleanup();

  act(() => {
    useSessions.setState({ cpu: { s1: 42.4 }, memory: { s1: 300 } });
  });
  renderRow("s1", false);
  expect(screen.getByTestId("cpu-chip-s1")).toHaveTextContent("42%");
});

// --- inactive-project fold ---

test("hiding is off by default, so every project keeps its place", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("Project p2")).toBeInTheDocument();
  expect(
    screen.queryByTestId("inactive-projects-summary")
  ).not.toBeInTheDocument();
});

test("a project whose every session is stale folds into one summary row", () => {
  // p1 keeps a running session (age never buries live work); p2 holds only a
  // read, finished one, so the whole group leaves the rail.
  seed();
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("Project p1")).toBeInTheDocument();
  expect(screen.queryByText("Project p2")).not.toBeInTheDocument();

  const summary = screen.getByTestId("inactive-projects-summary");
  expect(summary).toHaveTextContent("1 inactive project");

  fireEvent.click(summary);
  expect(screen.getByText("Project p2")).toBeInTheDocument();
});

test("an expanded inactive project is not a drag surface", () => {
  seed();
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("inactive-projects-summary"));
  expect(
    screen
      .getByTestId("project-drag-handle-p2")
      .getAttribute("aria-roledescription")
  ).toBeNull();
});

test("filtering shows inactive projects again", () => {
  // A searched rail answers the query, not the staleness policy — the same
  // rule the per-session "N older" fold follows.
  seed();
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(screen.getByLabelText("Filter sessions"), {
    target: { value: "session three" },
  });
  expect(screen.getByText("Project p2")).toBeInTheDocument();
  expect(
    screen.queryByTestId("inactive-projects-summary")
  ).not.toBeInTheDocument();
});

test("picking a session inside the fold closes the fold behind it", () => {
  // Two dormant projects, so the summary row survives the pick — with only
  // one, the fold vanishes wholesale and the auto-close is unobservable.
  seed();
  const state = useSessions.getState();
  state.addProject(makeProject("p3"));
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 4,
    cwd: "",
    id: "s4",
    projectId: "p3",
    status: "done",
    summary: "",
    title: "Session Four",
    titleLocked: false,
    worktreePath: null,
  });
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId("inactive-projects-summary"));
  fireEvent.click(screen.getByTestId("project-header-p2"));
  fireEvent.click(screen.getByRole("button", { name: "Open Session Three" }));

  // The picked project rejoins the rail; the fold snaps shut behind it
  // instead of leaving the remaining dormant groups sprawled open.
  expect(screen.getByText("Project p2")).toBeInTheDocument();
  expect(screen.queryByTestId("inactive-block")).not.toBeInTheDocument();
  expect(screen.getByTestId("inactive-projects-summary")).toHaveTextContent(
    "1 inactive project"
  );
});

test("a project with only archived sessions leaves the rail", () => {
  seed();
  act(() => {
    useSessions.getState().archiveSession("s3");
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByText("Project p1")).toBeInTheDocument();
  expect(screen.queryByText("Project p2")).not.toBeInTheDocument();
});

// --- clearing a project ---

test("clearing a project closes every one of its sessions", () => {
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  // The first click only asks — nothing is closed until the confirm.
  expect(onCloseSession).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("confirm-clear-project-p1"));
  expect(
    onCloseSession.mock.calls.map(([id]) => id).sort((a, b) => (a < b ? -1 : 1))
  ).toEqual(["s1", "s2"]);
});

test("clearing takes the project's archived sessions with it", () => {
  // An archived session is exactly what leaves an empty group behind, so a
  // clear that skipped them would not actually clear the project.
  seed();
  act(() => {
    useSessions.getState().archiveSession("s2");
  });
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  fireEvent.click(screen.getByTestId("confirm-clear-project-p1"));
  expect(
    onCloseSession.mock.calls.map(([id]) => id).sort((a, b) => (a < b ? -1 : 1))
  ).toEqual(["s1", "s2"]);
});

test("cancelling the clear confirm leaves every session open", () => {
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCloseSession).not.toHaveBeenCalled();
  expect(screen.getByText("Session One")).toBeInTheDocument();
});

test("the clear confirm names how many sessions go", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p2"));
  fireEvent.click(screen.getByTestId("clear-project-p2"));
  expect(screen.getByTestId("confirm-clear-project-p2")).toHaveTextContent(
    "Close 1 session"
  );
});

test("the clear confirm is a centered modal, not a popover over the rail", () => {
  // It used to hang off the ⋯ as an anchored popover, which put a block of
  // text in the middle of the sidebar covering other projects. A decision
  // this destructive belongs in the app's modal, like the quit warning.
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));

  // The menu is gone; the scrimmed dialog has taken over.
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByTestId("clear-project-backdrop")).toBeInTheDocument();
  expect(screen.getByTestId("clear-project-backdrop").parentElement).not.toBe(
    screen.getByTestId("sidebar")
  );
});

test("Escape backs out of the clear confirm", () => {
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  fireEvent.keyDown(window, { key: "Escape" });

  expect(
    screen.queryByTestId("confirm-clear-project-p1")
  ).not.toBeInTheDocument();
  expect(onCloseSession).not.toHaveBeenCalled();
});

test("a toast reports what the clear closed", () => {
  seed();
  render(
    <>
      <Sidebar
        onCloseSession={vi.fn()}
        onNewSession={vi.fn()}
        onShowAbout={vi.fn()}
      />
      <Toast />
    </>
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  fireEvent.click(screen.getByTestId("confirm-clear-project-p1"));

  expect(
    screen.getByText("Closed 2 sessions in Project p1")
  ).toBeInTheDocument();
});

test("when every project is inactive the fold shows, not the empty hint", () => {
  // The render split the old `projects.length === 0 ? hint : groups` ternary
  // into two independent conditionals. This is the case that separates them:
  // projects exist, none are on the rail. Folding it back into one ternary
  // would show "No open sessions" over a rail that has a fold in it.
  seed();
  act(() => {
    useSessions.getState().applyStatus("s1", "done", "");
    // The active session's project is always exempt, so this branch is only
    // reachable with nothing active — a hydrated store before the first
    // selection.
    useSessions.setState({ activeSessionId: null });
  });
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" },
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByText(EMPTY_HINT)).not.toBeInTheDocument();
  expect(screen.getByTestId("inactive-projects-summary")).toHaveTextContent(
    "2 inactive projects"
  );
});

test("the clear closes only the sessions the confirm was opened about", () => {
  // The dialog names a count when it opens. ⌘K has no open-modal guard, so a
  // session can be created in the same project while it is up — and a commit
  // that re-queried the project would kill a session that never appeared in
  // any confirm.
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  expect(screen.getByTestId("confirm-clear-project-p1")).toHaveTextContent(
    "Close 2 sessions"
  );

  act(() => {
    useSessions.getState().addSession({
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 99,
      cwd: "",
      id: "late",
      projectId: "p1",
      status: "idle",
      summary: "",
      title: "Arrived mid-confirm",
      titleLocked: false,
      worktreePath: null,
    });
  });
  fireEvent.click(screen.getByTestId("confirm-clear-project-p1"));

  expect(
    onCloseSession.mock.calls.map(([id]) => id).sort((a, b) => (a < b ? -1 : 1))
  ).toEqual(["s1", "s2"]);
});

test("a session closed elsewhere mid-confirm is not closed twice", () => {
  seed();
  const onCloseSession = vi.fn();
  render(
    <Sidebar
      onCloseSession={onCloseSession}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("clear-project-p1"));
  act(() => {
    useSessions.getState().removeSession("s2");
  });
  fireEvent.click(screen.getByTestId("confirm-clear-project-p1"));

  expect(onCloseSession.mock.calls.map(([id]) => id)).toEqual(["s1"]);
});

// --- project name disambiguation ---

/** Two checkouts of the same repo — the rail's real ambiguity. */
function seedTwins(): void {
  const state = useSessions.getState();
  state.addProject({
    color: null,
    id: "t1",
    name: "acme",
    path: "/Users/p/Projects/Acme/acme",
    setupCommand: null,
  });
  state.addProject({
    color: null,
    id: "t2",
    name: "acme",
    path: "/Users/p/Projects/Acme/review/acme",
    setupCommand: null,
  });
  for (const [id, projectId] of [
    ["a", "t1"],
    ["b", "t2"],
  ] as const) {
    state.addSession({
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 1,
      cwd: "",
      id,
      projectId,
      status: "running",
      summary: "",
      title: `Session ${id}`,
      titleLocked: false,
      worktreePath: null,
    });
  }
}

test("identically named projects are told apart by their shortest distinct parent", () => {
  seedTwins();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByTestId("project-qualifier-t1")).toHaveTextContent("Acme/");
  expect(screen.getByTestId("project-qualifier-t2")).toHaveTextContent(
    "review/"
  );
});

test("a project nothing collides with carries no qualifier at all", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByTestId("project-qualifier-p1")).not.toBeInTheDocument();
  expect(screen.queryByTestId("project-qualifier-p2")).not.toBeInTheDocument();
});

test("the header's tooltip carries the full path either way", () => {
  seedTwins();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.getByTestId("project-header-t2")).toHaveAttribute(
    "title",
    "/Users/p/Projects/Acme/review/acme"
  );
});

// --- the bounded inactive block ---

test("revealed inactive projects sit inside their own bounded block", () => {
  seed();
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  expect(screen.queryByTestId("inactive-block")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("inactive-projects-summary"));

  const block = screen.getByTestId("inactive-block");
  // The whole point of the block: the eye can see where inactive begins and
  // ends, and the active groups are demonstrably outside it.
  expect(within(block).getByText("Project p2")).toBeInTheDocument();
  expect(within(block).queryByText("Project p1")).not.toBeInTheDocument();
});

test("a dormant project opens collapsed, so it adds one row and no chrome", () => {
  seed();
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );
  fireEvent.click(screen.getByTestId("inactive-projects-summary"));

  const block = screen.getByTestId("inactive-block");
  expect(
    within(block).queryByTestId("project-children")
  ).not.toBeInTheDocument();
  // Opening it in place restores the full group.
  fireEvent.click(screen.getByTestId("project-header-p2"));
  expect(within(block).getByTestId("project-children")).toBeInTheDocument();
});

test("a dormant project says how stale it is", () => {
  seed();
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );
  fireEvent.click(screen.getByTestId("inactive-projects-summary"));

  // p2's only session was created at epoch+3ms — decades ago. The chip must
  // still read as a relative span ("56y"), never as a calendar date: the row
  // answers "how stale", not "when".
  expect(screen.getByTestId("dormant-age-p2")).toHaveTextContent(
    RE_COMPACT_AGE
  );
  // An active project must not carry one.
  expect(screen.queryByTestId("dormant-age-p1")).not.toBeInTheDocument();
});

// --- the merged older · history row ---

test("older sessions and history share one disclosure row", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // With nothing folded, the row still offers history — one row, not two.
  const row = screen.getByTestId("older-summary-p1");
  expect(row).toHaveTextContent(RE_HISTORY_ONLY);
  expect(screen.queryByTestId("history-list")).not.toBeInTheDocument();

  fireEvent.click(row);
  expect(screen.getByTestId("history-list")).toBeInTheDocument();
});

test("the merged row names the folded sessions when there are some", () => {
  seed();
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, hideOlderThan: "1d" } });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  // p1 keeps its running session and folds the idle one.
  const row = screen.getByTestId("older-summary-p1");
  expect(row).toHaveTextContent("1 older");
  expect(row).toHaveTextContent(RE_HISTORY_HALF);

  fireEvent.click(row);
  // Both halves are behind the one control: the folded session, then history.
  expect(screen.getByText("Session Two")).toBeInTheDocument();
  expect(screen.getByTestId("history-list")).toBeInTheDocument();
});

test("a filtered rail drops the merged row entirely", () => {
  seed();
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );

  fireEvent.change(screen.getByLabelText("Filter sessions"), {
    target: { value: "Session One" },
  });
  expect(screen.queryByTestId("older-summary-p1")).not.toBeInTheDocument();
});

function seedTasks(id: string, statuses: TaskStatus[]): void {
  useSessions.setState((s) => ({
    activity: {
      ...s.activity,
      [id]: {
        main: { currentTool: null },
        pendingAsk: null,
        shells: [],
        subagents: [],
        tasks: statuses.map((status, i) => ({
          activeForm: status === "in_progress" ? `Doing task ${i}` : null,
          status,
          text: `Task ${i}`,
        })),
      },
    },
  }));
}

test("a row shows its task progress, with the current item in the tooltip", () => {
  seedSession("s1", { title: "Tasks" });
  seedTasks("s1", ["completed", "in_progress", "pending"]);
  renderRow("s1", false);
  const chip = screen.getByTestId("task-progress-s1");
  expect(chip).toHaveTextContent("1/3");
  expect(chip).toHaveAttribute("title", "Tasks: 1 of 3 done · Doing task 1");
});

test("a row whose tasks are all done shows no task progress", () => {
  seedSession("s1", { title: "Tasks" });
  seedTasks("s1", ["completed", "completed"]);
  renderRow("s1", false);
  expect(screen.queryByTestId("task-progress-s1")).not.toBeInTheDocument();
});

test("a row shows how full its context window is, toned as it fills", () => {
  seedSession("s1", { title: "Context" });
  act(() => {
    useSessions.setState({
      usage: {
        s1: {
          contextWindowSize: 200_000,
          inputTokens: 170_000,
          model: null,
          outputTokens: null,
          sessionId: null,
          usedPercentage: 85,
        },
      },
    });
  });
  renderRow("s1", false);
  const chip = screen.getByTestId("context-chip-s1");
  expect(chip).toHaveTextContent("85% ctx");
  expect(chip).toHaveStyle({ color: tokens.color.status.waiting });
});

test("a row without Claude's context reading shows no context chip", () => {
  seedSession("s1", { title: "Context" });
  act(() => {
    useSessions.setState({ usage: {} });
  });
  renderRow("s1", false);
  expect(screen.queryByTestId("context-chip-s1")).not.toBeInTheDocument();
});

test("resting the pointer on a row opens its pty early; sweeping past does not", () => {
  vi.useFakeTimers();
  seedSession("s1", { title: "Hover me" });
  const prewarm = vi.mocked(prewarmSession);
  prewarm.mockClear();
  renderRow("s1", false);
  const row = screen.getByTestId("session-row");
  fireEvent.pointerEnter(row);
  vi.advanceTimersByTime(PREWARM_DWELL_MS - 1);
  fireEvent.pointerLeave(row);
  vi.advanceTimersByTime(PREWARM_DWELL_MS);
  expect(prewarm).not.toHaveBeenCalled();
  fireEvent.pointerEnter(row);
  vi.advanceTimersByTime(PREWARM_DWELL_MS);
  expect(prewarm).toHaveBeenCalledWith("s1");
  vi.useRealTimers();
});

test("a nested session steps in under the session it was started from", () => {
  seed();
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 4,
    cwd: "",
    id: "s4",
    nestedUnder: "s1",
    projectId: "p1",
    status: "running",
    summary: "",
    title: "Nested One",
    titleLocked: false,
    worktreePath: null,
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );
  const titles = screen
    .getAllByTestId("session-row")
    .map((row) => row.getAttribute("data-status") && row.textContent);
  const parentAt = titles.findIndex((t) => t?.includes("Session One"));
  expect(titles[parentAt + 1]).toContain("Nested One");
  const nestedRow = screen
    .getAllByTestId("session-row")
    .find((row) => row.textContent?.includes("Nested One"));
  expect(nestedRow?.querySelector("[data-nest-depth='1']")).not.toBeNull();
});

test("a row says when Claude suggested a session from it", () => {
  seedSession("s1", { title: "Lead" });
  useSessionProposals.setState({
    proposals: [
      {
        leadSessionId: "s1",
        request: {
          branch: null,
          initiation: "own_initiative",
          prompt: "p",
          requestId: "r1",
          title: "T",
          worktree: false,
        },
      },
    ],
  });
  renderRow("s1", false);
  expect(screen.getByTestId("suggested-chip-s1")).toHaveTextContent(
    "1 suggested"
  );
  useSessionProposals.setState({ proposals: [] });
});

test("a nested session whose lead is filtered out isn't drawn indented", () => {
  seed();
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 4,
    cwd: "",
    id: "s4",
    nestedUnder: "s1",
    projectId: "p1",
    status: "running",
    summary: "",
    title: "Nested One",
    titleLocked: false,
    worktreePath: null,
  });
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );
  fireEvent.change(screen.getByLabelText("Filter sessions"), {
    target: { value: "Nested" },
  });
  const nestedRow = screen
    .getAllByTestId("session-row")
    .find((row) => row.textContent?.includes("Nested One"));
  expect(nestedRow?.querySelector("[data-nest-depth='0']")).not.toBeNull();
});
