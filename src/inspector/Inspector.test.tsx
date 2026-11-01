import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { repoStatus } from "../ipc/bridge.ts";
import { useChanges } from "../state/changes.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { usePlanLimits } from "../state/planLimits.ts";
import { useProjectNotes } from "../state/projectNotes.ts";
import { useSessions } from "../state/sessions.ts";
import { LIMIT_NOTE } from "../state/usage.ts";
import type { FileDiff } from "../types.ts";
import { Inspector } from "./Inspector.tsx";

vi.mock("../ipc/bridge", () => ({
  activityStats: vi.fn(() => new Promise(() => undefined)),
  activityTurns: vi.fn(() => Promise.resolve([])),
  onActivityChanged: vi.fn(() => Promise.resolve(() => undefined)),
  repoStatus: vi.fn(),
}));

const mockedRepoStatus = vi.mocked(repoStatus);
const RE_DOLLAR = /\$/;
const RE_TOKENS_TOTAL = /tokens this session/;

beforeEach(() => {
  vi.clearAllMocks();
  mockedRepoStatus.mockResolvedValue({
    ahead: 1,
    behind: 0,
    branch: "dev",
    dirtyCount: 3,
  });
  useSessions.setState({
    activeSessionId: null,
    events: {},
    projects: [],
    repoToplevel: {},
    sessions: {},
    touchedFiles: {},
    usage: {},
  });
  usePlanLimits.setState({ limits: { fiveHour: null, sevenDay: null } });
  useChanges.setState({ bySession: {}, ui: {} });
  useLayout.setState({ inspectorTab: "details", layout: DEFAULT_LAYOUT });
  useProjectNotes.setState({ notes: [], pickedProjectId: null });
});

const CHANGES_HEADER_NAME = /changes/i;
const SEVEN_FILES_TEXT = /7 files/i;
const WORKING_TREE_CLEAN_RE = /working tree clean/i;

function file(path: string, status: FileDiff["status"] = "modified"): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@",
        lines: [
          { kind: "context", text: "keep" },
          { kind: "added", text: "new" },
        ],
      },
    ],
    oldPath: null,
    path,
    status,
  };
}

/** Seeds `sessionId` with a session record and a ready diff over `paths` —
 * does not activate it, so a caller controls when `Inspector` sees it. */
function seedSessionWithDiff(sessionId: string, paths: string[]): void {
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: Date.now(),
    cwd: "/work",
    id: sessionId,
    projectId: "p1",
    status: "running",
    summary: "",
    title: sessionId,
    titleLocked: false,
    worktreePath: null,
  });
  useChanges.setState({
    bySession: {
      [sessionId]: {
        baselineLabel: "HEAD · uncommitted",
        collapsed: {},
        diff: { base: "HEAD", files: paths.map((path) => file(path)) },
        fetchedAt: Date.now(),
        hunkHashes: {},
        status: "ready",
        totals: { additions: 0, deletions: 0, files: paths.length },
        viewed: {},
      },
    },
  });
}

/** Activates `sessionId` and renders the Inspector against it. */
function renderInspector(sessionId: string): void {
  useSessions.getState().setActiveSession(sessionId);
  render(<Inspector />);
}

function seedActive(): void {
  const state = useSessions.getState();
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: Date.now(),
    cwd: "/work",
    id: "s1",
    projectId: "p1",
    status: "running",
    summary: "",
    title: "Session One",
    titleLocked: false,
    worktreePath: null,
  });
  state.setActiveSession("s1");
}

test("renders the branch and uncommitted change count from repoStatus", async () => {
  seedActive();
  render(<Inspector />);

  expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
  expect(await screen.findByText("3 changes")).toBeInTheDocument();
});

test("the Usage section shows no cost and no token total", async () => {
  seedActive();
  render(<Inspector />);

  expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
  expect(screen.queryByText(RE_DOLLAR)).not.toBeInTheDocument();
  expect(screen.queryByText(RE_TOKENS_TOTAL)).not.toBeInTheDocument();
});

test("the context bar shows Claude's own reading, and a dash without one", async () => {
  seedActive();
  render(<Inspector />);
  expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
  expect(screen.getByTestId("usage-context")).toHaveTextContent("—");

  act(() => {
    useSessions.getState().applyUsage("s1", {
      contextWindowSize: 1_000_000,
      inputTokens: 60_804,
      model: null,
      outputTokens: 659,
      sessionId: null,
      usedPercentage: 6,
    });
  });
  expect(screen.getByTestId("usage-context")).toHaveTextContent("60.8k · 6%");
});

test("shows the 5-hour and weekly limit bars only when Claude reports them", async () => {
  seedActive();
  usePlanLimits.setState({ limits: { fiveHour: null, sevenDay: null } });
  render(<Inspector />);
  expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
  expect(screen.queryByText("5-hour limit")).not.toBeInTheDocument();

  const today = new Date();
  const fiveHour = new Date(today);
  fiveHour.setHours(23, 59, 0, 0);
  const weekly = new Date(today);
  weekly.setDate(today.getDate() + 3);
  weekly.setHours(5, 30, 0, 0);
  act(() => {
    usePlanLimits.getState().apply({
      fiveHour: { resetsAt: fiveHour.getTime() / 1000, usedPercentage: 23.5 },
      sevenDay: { resetsAt: weekly.getTime() / 1000, usedPercentage: 41.2 },
    });
  });
  const clock = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  expect(screen.getByTestId("usage-five-hour")).toHaveTextContent(
    `24% · resets ${clock(fiveHour)}`
  );
  const day = weekly.toLocaleDateString(undefined, { weekday: "short" });
  expect(screen.getByTestId("usage-seven-day")).toHaveTextContent(
    `41% · resets ${day} ${clock(weekly)}`
  );
  expect(screen.getByTestId("usage-five-hour")).toHaveAttribute(
    "title",
    LIMIT_NOTE
  );
});

test("warns when a limit is on course to run out before it resets", async () => {
  seedActive();
  const now = Date.now();
  const resetsAt = (now + 3 * 86_400_000) / 1000;
  usePlanLimits.setState({
    limits: { fiveHour: null, sevenDay: null },
    samples: { fiveHour: [], sevenDay: [] },
  });
  render(<Inspector />);
  expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
  act(() => {
    const { apply } = usePlanLimits.getState();
    apply(
      { fiveHour: null, sevenDay: { resetsAt, usedPercentage: 50 } },
      now - 30 * 60_000
    );
    apply({ fiveHour: null, sevenDay: { resetsAt, usedPercentage: 60 } }, now);
  });
  expect(screen.getByTestId("usage-pace")).toHaveTextContent(
    "Weekly limit runs out in about 2h at this rate"
  );
});

test("shows an empty state when there is no active session", () => {
  render(<Inspector />);

  expect(screen.getByText("No active session")).toBeInTheDocument();
  expect(mockedRepoStatus).not.toHaveBeenCalled();
});

test("clicking a changed file opens the Changes view and asks it to jump", () => {
  seedSessionWithDiff("s1", ["src/a.ts"]);
  renderInspector("s1");

  fireEvent.click(screen.getByText("a.ts"));

  expect(useLayout.getState().layout.transcriptView).toBe("changes");
  expect(useChanges.getState().ui.s1?.pendingJump).toBe("src/a.ts");
});

test("keeps the stats summary visible when the file list is collapsed", () => {
  // dirtyCount (3, from the shared beforeEach mock) and totals.files (7) are
  // deliberately different numbers here — a regression that swaps one for
  // the other must fail this assertion, not pass it by coincidence.
  seedSessionWithDiff("s1", ["src/a.ts", "src/b.ts", "src/c.ts"]);
  useChanges.setState((state) => ({
    bySession: {
      ...state.bySession,
      s1: {
        ...state.bySession.s1,
        totals: { additions: 10, deletions: 4, files: 7 },
      },
    },
  }));
  renderInspector("s1");

  expect(screen.getByText(SEVEN_FILES_TEXT)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: CHANGES_HEADER_NAME }));

  expect(screen.getByText(SEVEN_FILES_TEXT)).toBeVisible();
  expect(screen.getByTestId("changed-files-list")).not.toBeVisible();
});

test("shows a neutral placeholder, never the raw dirtyCount, in the header stat while totals have not loaded", async () => {
  // dirtyCount (9) must never leak into the header's stats slot — that slot
  // is reserved for `totals`, which is a different (noise-filtered,
  // baseline-relative) quantity. Before this fix, the null-totals fallback
  // rendered the bare dirtyCount there unlabeled.
  mockedRepoStatus.mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "dev",
    dirtyCount: 9,
  });
  seedActive();
  render(<Inspector />);

  // Wait for the async repoStatus() call to resolve before asserting.
  await screen.findByText("9 changes");

  const section = screen.getByTestId("inspector-changes-section");
  expect(within(section).getByTestId("changes-header-stat")).toHaveTextContent(
    "…"
  );
  expect(within(section).queryByText("9")).not.toBeInTheDocument();
});

test("never claims the working tree is clean directly above a populated file list", async () => {
  // `diff_session_changes` is tree-vs-tree, so a session that has *committed*
  // its edits still has a populated changed-files list while `git status`
  // reports a clean tree — the two sentences describe different populations
  // and must not read as one describing the other.
  mockedRepoStatus.mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "dev",
    dirtyCount: 0,
  });
  seedSessionWithDiff("s1", ["src/a.ts", "src/b.ts"]);
  renderInspector("s1");

  expect(await screen.findByText("No uncommitted changes")).toBeInTheDocument();
  const section = screen.getByTestId("inspector-changes-section");
  expect(
    within(section).queryByText(WORKING_TREE_CLEAN_RE)
  ).not.toBeInTheDocument();
  expect(within(section).getByText("a.ts")).toBeInTheDocument();
});

test("totals and the file list follow the My-edits-only filter", () => {
  seedSessionWithDiff("s1", ["src/a.ts", "src/b.ts"]);
  useChanges.setState((state) => ({
    bySession: {
      ...state.bySession,
      s1: {
        ...state.bySession.s1,
        totals: { additions: 2, deletions: 0, files: 2 },
      },
    },
    ui: { s1: { myEditsOnly: true } },
  }));
  useSessions.setState({
    repoToplevel: { s1: "/work" },
    touchedFiles: { s1: ["/work/src/a.ts"] },
  });
  renderInspector("s1");

  const section = screen.getByTestId("inspector-changes-section");
  expect(within(section).getByTestId("changes-header-stat")).toHaveTextContent(
    "1 file +1 −0"
  );
  expect(within(section).getByText("a.ts")).toBeInTheDocument();
  expect(within(section).queryByText("b.ts")).not.toBeInTheDocument();
});

test("with the filter on but Claude's files unknown, the Inspector lists everything, as the centre does", () => {
  seedSessionWithDiff("s1", ["src/a.ts", "src/b.ts"]);
  useChanges.setState({ ui: { s1: { myEditsOnly: true } } });
  useSessions.setState({
    repoToplevel: { s1: "/work" },
    // Claude wrote only outside the repo, so none of its files match it.
    touchedFiles: { s1: ["/Users/you/notes/plan.md"] },
  });
  renderInspector("s1");

  const section = screen.getByTestId("inspector-changes-section");
  expect(within(section).getByText("a.ts")).toBeInTheDocument();
  expect(within(section).getByText("b.ts")).toBeInTheDocument();
});

test("the Activity tab swaps the Details body for the session's activity log", async () => {
  seedSessionWithDiff("s1", ["a.ts"]);
  renderInspector("s1");
  expect(screen.getByText("Session")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByTestId("activity-tab")).toBeTruthy();
  expect(screen.queryByText("Session")).toBeNull();
  expect(
    await screen.findByText(
      "No activity yet. Steps appear here as Claude works."
    )
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  expect(screen.queryByTestId("activity-tab")).toBeNull();
});

const NOTES_TAB_RE = /Notes/;

const PROJECT = {
  color: null,
  id: "p1",
  name: "kriyon",
  path: "/work",
  setupCommand: null,
};

function seedNote(text: string, kind: "todo" | "idea" = "todo"): void {
  useProjectNotes.setState((state) => ({
    notes: [
      ...state.notes,
      {
        body: "",
        createdMs: Date.now(),
        doneAt: null,
        id: text,
        kind,
        pinned: false,
        projectId: "p1",
        text,
        updatedMs: Date.now(),
      },
    ],
  }));
}

test("the Notes tab lists the active session's project notes, its todo count on the tab", () => {
  useSessions.setState({ projects: [PROJECT] });
  seedNote("Write the ADR");
  seedNote("Ship it");
  seedNote("Split view", "idea");
  seedSessionWithDiff("s1", []);
  renderInspector("s1");

  const tab = screen.getByRole("tab", { name: NOTES_TAB_RE });
  expect(tab.textContent).toContain("2");
  fireEvent.click(tab);
  expect(screen.getByTestId("notes-tab")).toBeTruthy();
  expect(screen.getByText("Split view")).toBeTruthy();
  expect(screen.queryByText("Session")).toBeNull();
});

test("the Notes tab shows a project picked from the sidebar even with no session open", () => {
  useSessions.setState({ projects: [PROJECT] });
  seedNote("Write the ADR");
  useProjectNotes.setState({ pickedProjectId: "p1" });
  useLayout.setState({ inspectorTab: "notes" });
  render(<Inspector />);
  expect(screen.getByText("Write the ADR")).toBeTruthy();
});

test("with no session open, Details keeps the tab strip so Notes stays reachable", () => {
  useSessions.setState({ projects: [PROJECT] });
  seedNote("Write the ADR");
  useProjectNotes.setState({ pickedProjectId: "p1" });
  useLayout.setState({ inspectorTab: "notes" });
  render(<Inspector />);

  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  expect(screen.getByText("No active session")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: NOTES_TAB_RE }));
  expect(screen.getByText("Write the ADR")).toBeTruthy();
});
